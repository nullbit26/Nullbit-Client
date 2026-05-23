'use strict'

const { Vec3 } = require('vec3')
const { getFreeSlots } = require('../utils/inventoryValue')

/**
 * TreeJob — FSM for felling a single locked tree.
 *
 * General execution contract (reusable pattern for any interaction task):
 *   lock target → scan remaining work → pick valid action spot →
 *   navigate to spot → (bounded blocker-clear if needed) → interact →
 *   collect → repeat until complete or bounded-fail
 *
 * States:
 *   LOCK_TREE        — identify and lock the target tree (X,Z)
 *   SELECT_LOG       — pick the lowest remaining unfailed log on locked trunk
 *   FIND_SPOT        — heuristic-score candidate dig spots, exact-nav-test top 2
 *   NAV_TO_SPOT      — navigate to the chosen dig spot
 *   CLEAR_BLOCKERS   — targeted leaf-clear around spot (max 1 attempt per log)
 *   DIG_LOG          — face + dig the log block
 *   COLLECT          — wait for drop, navigate to item entity
 *   COMPLETE_TREE    — all logs done; caller picks next tree
 *   FAIL_TREE        — bounded retries exhausted; caller picks next tree
 *
 * Invariants:
 *   1. While locked, never switch to leaves as an independent target.
 *   2. If no valid spot found after 1 blocker-clear → FAIL_TREE.
 *   3. Last log gets priority over leaf-clear and tree-switch.
 *   4. If nav to a spot gets partial > PARTIAL_LIMIT times → abandon spot.
 *   5. No infinite pre_dig→goto→partial cycles.
 */

const { NavEvents } = require('../core/EventRegistry')
const { equipBestAxe } = require('../utils/equipBestTool')
const { BaseJob } = require('./BaseJob')

/** Resource telemetry counters for NULLBIT Launcher */
let treeChoppedCount = 0
let treeFailedCount = 0
let dangerStopCount = 0
let lastTreeSummary = null
let lastJsonEmit = 0

/** @private Emit resource debug JSON for NULLBIT Launcher (throttled: once per 5 sec) */
function _emitTreeJobDebug (extra = {}) {
  try {
    const now = Date.now()
    if (now - lastJsonEmit < 5000 && !extra.summary) return
    lastJsonEmit = now
    
    const payload = {
      type: 'resource',
      trees: treeChoppedCount,
      ores: 0, // TreeJob doesn't mine ores
      fallbacks: 0,
      dangerStops: dangerStopCount,
      status: extra.summary ? 'SUMMARY' : (extra.status || 'GATHERING'),
      summary: extra.summary || null,
      job: 'TreeJob',
      ...extra
    }
    console.log(JSON.stringify(payload))
  } catch (_) {}
}

/** Nav goal range when heading to a dig spot */
const SPOT_NAV_RANGE = 1
/** How long to wait before calling nav stalled (ms) */
const NAV_STALL_MS = 4000
/** Full nav deadline (ms) — hard cut */
const NAV_TIMEOUT_MS = 12_000
/** How many consecutive partial path results before abandoning a spot */
const PARTIAL_LIMIT = 4
/** Settle delay after arriving before dig (ms) */
const DIG_SETTLE_MS = 200
/** Drop collection wait after dig (ms) */
const DROPS_WAIT_MS = 500
/** Radius to scan for dropped item entities */
const DROP_COLLECT_RADIUS = 8
/** Dig-fail cooldown before next attempt (ms) */
const DIG_FAIL_COOLDOWN_MS = 1500
/** Max leaves cleared per blocker-clear attempt */
const MAX_LEAF_CLEAR = 5
/** Heuristic scan offsets [dx, dy, dz] for candidate dig spots around a log.
 * dy is relative to the log Y — negative = bot stands below the log (digs upward). */
const DIG_REACH = 6.5
const SPOT_SCAN_OFFSETS = [
  // cardinal same Y
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  // cardinal 1 below (dig up at slight angle)
  [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
  // cardinal 2 below (higher logs, bot on ground)
  [1, -2, 0], [-1, -2, 0], [0, -2, 1], [0, -2, -1],
  // cardinal 3 below (tall trees)
  [1, -3, 0], [-1, -3, 0], [0, -3, 1], [0, -3, -1],
  // cardinal 4 below (very tall trees, top logs)
  [1, -4, 0], [-1, -4, 0], [0, -4, 1], [0, -4, -1],
  // cardinal 5 below
  [1, -5, 0], [-1, -5, 0], [0, -5, 1], [0, -5, -1],
  // cardinal 6 below
  [1, -6, 0], [-1, -6, 0], [0, -6, 1], [0, -6, -1],
  // cardinal 7 below (giant trees / jungle)
  [1, -7, 0], [-1, -7, 0], [0, -7, 1], [0, -7, -1],
  // cardinal 8 below
  [1, -8, 0], [-1, -8, 0], [0, -8, 1], [0, -8, -1],
  // diagonal same Y
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  // diagonal 1 below
  [1, -1, 1], [-1, -1, 1], [1, -1, -1], [-1, -1, -1]
]

const LOG_NAME_RE = /(_log|_stem|_hyphae|_wood)$/
const LEAVES_RE = /_leaves$/

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @typedef {Object} TreeJobOpts
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/EventBus').EventBus} bus
 * @property {any} [logger]        — optional logger with .info/.warn
 * @property {any} [movement]      — optional movementActions (for setPathfinderDigEnabled)
 * @property {() => boolean} [shouldInterrupt]  — returns true when combat/FLEE detected
 * @property {() => void} [onBlockCollected]     — called after each log is collected
 * @property {import('prismarine-block').Block} [initialLog]  — pre-selected first log (skips findBlock on first SELECT_LOG)
 * @property {Array<{x:number,y:number,z:number}>} [initialPositions] — pre-scanned trunk positions sorted lowest-first
 * @property {number} [navPollMs]  — override for tests
 * @property {number} [dropsWaitMs]
 * @property {number} [digSettleMs]
 */

class TreeJob extends BaseJob {
  /**
   * @param {TreeJobOpts} opts
   * @param {{ tx: number, tz: number }} treeLock — the X,Z of the trunk to fell
   * @param {Map<string, number>} failedBlocks    — shared failed-block registry (blockKey → timestamp)
   * @param {() => boolean} alive                 — loop liveness guard
   */
  constructor (opts, treeLock, failedBlocks, alive) {
    super()
    this._bot = opts.bot
    this._bus = opts.bus
    this._log = opts.logger || null
    this._movement = opts.movement || null
    this._shouldInterrupt = opts.shouldInterrupt || (() => false)
    this._onBlockCollected = opts.onBlockCollected || null
    // Pre-seed _currentLog if caller already found the first block (avoids re-scanning)
    this._currentLog = opts.initialLog || null
    // Pre-seed trunk log position cache if caller already scanned the tree
    this._trunkLogs = opts.initialPositions?.length ? opts.initialPositions.slice() : null
    this._navPollMs = opts.navPollMs ?? 200
    this._dropsWaitMs = opts.dropsWaitMs ?? DROPS_WAIT_MS
    this._digSettleMs = opts.digSettleMs ?? DIG_SETTLE_MS

    this._lock = treeLock   // { tx, tz }
    this._failed = failedBlocks
    this._alive = alive

    /** @type {'SELECT_LOG'|'FIND_SPOT'|'NAV_TO_SPOT'|'CLEAR_BLOCKERS'|'DIG_LOG'|'COLLECT'|'COMPLETE_TREE'|'FAIL_TREE'} */
    this.state = 'SELECT_LOG'

    this._currentSpot = null  // { x, y, z } standing position
    this._blockerClearUsed = false
    this._partialCount = 0
    // _trunkLogs initialised above from opts.initialPositions (or null = scan on first SELECT_LOG)

    // Telemetry counters (reset per-job, logged on completion)
    this._telemetry = {
      startMs: Date.now(),
      logsDigged: 0,
      navProbeCount: 0,
      totalPartials: 0,
      blockerClearCount: 0,
      failedLogs: 0
    }

    // partial-path listener
    this._onPathResult = this._onPathResult.bind(this)
    this._bus.on(NavEvents.PATH_RESULT, this._onPathResult)
  }

  /** @private */
  _onPathResult (payload) {
    if (payload?.status === 'partial') {
      this._partialCount++
      this._telemetry.totalPartials++
    }
  }

  /** Detach bus listener — call when job is done or abandoned */
  destroy () {
    this._bus.off(NavEvents.PATH_RESULT, this._onPathResult)
  }

  /** @override */
  get metrics () {
    const t = this._telemetry
    return {
      jobType: 'tree',
      durationMs: Date.now() - t.startMs,
      blocksDigged: t.logsDigged,
      navProbes: t.navProbeCount,
      totalPartials: t.totalPartials,
      blockerClears: t.blockerClearCount,
      failedBlocks: t.failedLogs,
      failReason: t.failReason || null
    }
  }

  // ---------------------------------------------------------------------------
  // Public entry: run the full FSM to completion or failure
  // Returns 'complete' | 'fail' | 'interrupted'
  // ---------------------------------------------------------------------------
  async run () {
    const t = this._telemetry
    try {
      while (this._alive()) {
        if (this._shouldInterrupt()) return 'interrupted'

        // Check if need to return home (inventory full or no axe)
        const slots = getFreeSlots(this._bot)
        if (slots <= 2) {
          this._info('inventory full — returning home')
          return 'paused_for_home'
        }

        const hasAxe = this._bot.inventory.items().some(i => i.name.includes('axe'))
        if (!hasAxe) {
          this._info('no axe — returning home for crafting')
          return 'paused_for_home'
        }

        switch (this.state) {
          case 'SELECT_LOG':      await this._stateSelectLog(); break
          case 'FIND_SPOT':       await this._stateFindSpot(); break
          case 'NAV_TO_SPOT':     await this._stateNavToSpot(); break
          case 'CLEAR_BLOCKERS':  await this._stateClearBlockers(); break
          case 'DIG_LOG':         await this._stateDigLog(); break
          case 'COLLECT':         await this._stateCollect(); break
          case 'COMPLETE_TREE':   await this._stateCompleteTree(); return 'complete'
          case 'FAIL_TREE':       return 'fail'
          default:                return 'fail'
        }
      }
    } finally {
      this.destroy()
      const elapsed = Date.now() - t.startMs
      this._info(
        `telemetry tree=${this._lock.tx},${this._lock.tz}` +
        ` durationMs=${elapsed}` +
        ` logsDigged=${t.logsDigged}` +
        ` navProbes=${t.navProbeCount}` +
        ` totalPartials=${t.totalPartials}` +
        ` blockerClears=${t.blockerClearCount}` +
        ` failedLogs=${t.failedLogs}`
      )
    }
    return 'interrupted'
  }

  // ---------------------------------------------------------------------------
  // SELECT_LOG: pick lowest unfailed log at locked X,Z
  // ---------------------------------------------------------------------------
  async _stateSelectLog () {
    // Pre-scan trunk on first call so subsequent calls are O(1) array pops
    if (this._trunkLogs === null) {
      this._trunkLogs = this._scanTrunkLogs()
      this._info(`pre-scanned ${this._trunkLogs.length} trunk logs`)
    }
    // Evict failed entries from the cached list
    this._trunkLogs = this._trunkLogs.filter(p => !this._failed.has(_bk(p)))
    // Verify the lowest cached position is still a real log block
    let log = null
    while (this._trunkLogs.length > 0) {
      const p = this._trunkLogs[0]
      const fresh = this._bot.blockAt?.(new Vec3(p.x, p.y, p.z))
      if (fresh && LOG_NAME_RE.test(fresh.name)) { log = fresh; break }
      this._trunkLogs.shift() // block gone (physics drop), remove and try next
    }
    if (!log) {
      // Cache exhausted — do one final live scan in case new logs appeared (shouldn't happen but safe)
      log = this._getLowestTrunkLog()
      if (log) this._trunkLogs = [log.position] // re-seed
    }
    if (!log) {
      this._info('no more logs on locked trunk — COMPLETE_TREE')
      this.state = 'COMPLETE_TREE'
      return
    }
    this._currentLog = log
    this._currentSpot = null
    this._blockerClearUsed = false
    this._partialCount = 0
    this._info(`selected log at ${_bk(log.position)}`)
    this.state = 'FIND_SPOT'
  }

  // ---------------------------------------------------------------------------
  // FIND_SPOT: heuristic-score candidates, then exact-nav-test top 2
  // ---------------------------------------------------------------------------
  async _stateFindSpot () {
    this._partialCount = 0 // reset so stale partials from previous nav don't poison this attempt
    const logPos = this._currentLog.position

    // Fast-path: bot is already close enough to dig — no nav needed
    const botPos = this._bot.entity?.position
    if (botPos && _dist3(botPos, logPos) <= DIG_REACH) {
      this._currentSpot = { x: Math.floor(botPos.x), y: Math.floor(botPos.y), z: Math.floor(botPos.z), score: 0 }
      this._partialCount = 0
      this.state = 'DIG_LOG'
      return
    }

    const candidates = this._scoreCandidateSpots(logPos)

    if (candidates.length === 0) {
      this._warn('no heuristic spots found — trying adjacent fallback positions')
      // Try cardinal adjacent spots at dy=-1,-2,-3 (not the log block itself — it's solid)
      const lp = this._currentLog.position
      const fallbacks = [
        [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
        [1, -2, 0], [-1, -2, 0], [0, -2, 1], [0, -2, -1],
        [1, -3, 0], [-1, -3, 0], [0, -3, 1], [0, -3, -1],
        [1, -4, 0], [-1, -4, 0], [0, -4, 1], [0, -4, -1],
        [1, -5, 0], [-1, -5, 0], [0, -5, 1], [0, -5, -1],
        [1, -6, 0], [-1, -6, 0], [0, -6, 1], [0, -6, -1],
        [1, -7, 0], [-1, -7, 0], [0, -7, 1], [0, -7, -1],
        [1, -8, 0], [-1, -8, 0], [0, -8, 1], [0, -8, -1]
      ].map(([dx, dy, dz]) => ({ x: lp.x + dx, y: lp.y + dy, z: lp.z + dz, score: 0 }))
      if (this._movement?.setPathfinderDigEnabled) this._movement.setPathfinderDigEnabled(true)
      let chosen = null
      for (const fb of fallbacks) {
        if (!this._alive() || this._shouldInterrupt()) break
        this._partialCount = 0
        if (await this._probeNavSpot(fb, 1200)) { chosen = fb; break }
      }
      if (this._movement?.setPathfinderDigEnabled) this._movement.setPathfinderDigEnabled(false)
      if (!this._alive() || this._shouldInterrupt()) return
      if (chosen) {
        this._currentSpot = chosen
        this._partialCount = 0
        this.state = 'DIG_LOG'
        return
      }
      if (!this._blockerClearUsed) {
        this._blockerClearUsed = true
        this.state = 'CLEAR_BLOCKERS'
        return
      }
      this._fail_log()
      return
    }

    // Test top 2 candidates with a short real nav probe
    const top = candidates.slice(0, 2)
    let chosen = null

    // First check: can bot directly reach it right now (already in range)?
    if (botPos) {
      for (const c of top) {
        const d = _dist3(botPos, c)
        if (d <= SPOT_NAV_RANGE + 1) { chosen = c; break }
      }
    }

    if (!chosen) {
      // Enable dig for nav probe
      if (this._movement?.setPathfinderDigEnabled) this._movement.setPathfinderDigEnabled(true)
      for (const c of top) {
        if (!this._alive() || this._shouldInterrupt()) break
        const reachable = await this._probeNavSpot(c)
        if (reachable) { chosen = c; break }
      }
      if (this._movement?.setPathfinderDigEnabled) this._movement.setPathfinderDigEnabled(false)
      if (!this._alive() || this._shouldInterrupt()) return
    }

    if (!chosen) {
      this._warn('nav probe failed for all candidates')
      if (!this._blockerClearUsed) {
        this._blockerClearUsed = true
        this.state = 'CLEAR_BLOCKERS'
        return
      }
      this._fail_log()
      return
    }

    this._currentSpot = chosen
    this._partialCount = 0
    this._info(`spot chosen (${chosen.x},${chosen.y},${chosen.z}) score=${chosen.score.toFixed(1)}`)
    this.state = 'NAV_TO_SPOT'
  }

  // ---------------------------------------------------------------------------
  // NAV_TO_SPOT: navigate to the chosen dig spot
  // ---------------------------------------------------------------------------
  async _stateNavToSpot () {
    const { x, y, z } = this._currentSpot
    // Skip nav if probe already left us in range
    const botPos = this._bot.entity?.position
    if (botPos && _dist3(botPos, { x, y, z }) <= SPOT_NAV_RANGE + 0.5) {
      this.state = 'DIG_LOG'
      return
    }
    if (this._movement?.setPathfinderDigEnabled) this._movement.setPathfinderDigEnabled(true)
    const arrived = await this._navigateTo(x, y, z, SPOT_NAV_RANGE)
    if (this._movement?.setPathfinderDigEnabled) this._movement.setPathfinderDigEnabled(false)

    if (!arrived) {
      this._warn(`nav to spot failed (partials=${this._partialCount})`)
      if (!this._blockerClearUsed) {
        this._blockerClearUsed = true
        this.state = 'CLEAR_BLOCKERS'
        return
      }
      this._fail_log()
      return
    }

    this.state = 'DIG_LOG'
  }

  // ---------------------------------------------------------------------------
  // CLEAR_BLOCKERS: targeted leaf-clear around the log and spot
  // ---------------------------------------------------------------------------
  async _stateClearBlockers () {
    this._telemetry.blockerClearCount++
    const logPos = this._currentLog.position
    await this._clearTargetedBlockers(logPos)
    if (!this._alive()) return
    // After clearing, re-run spot selection from scratch
    this._currentSpot = null
    this._partialCount = 0
    this.state = 'FIND_SPOT'
  }

  // ---------------------------------------------------------------------------
  // DIG_LOG: settle, equip axe, face block, dig
  // ---------------------------------------------------------------------------
  async _stateDigLog () {
    this._bus.emit(NavEvents.STOP, { reason: 'pre_dig', at: Date.now() })
    await sleep(this._digSettleMs)
    if (!this._alive()) return

    try { await equipBestAxe(this._bot) } catch (_) {}
    if (!this._alive()) return

    const blockKey = _bk(this._currentLog.position)
    const fresh = this._bot.blockAt?.(this._currentLog.position)

    if (!fresh || !LOG_NAME_RE.test(fresh.name)) {
      this._info('log already gone — continue')
      this.state = 'SELECT_LOG'
      return
    }

    // Jump-dig: if log is above bot eye level, jump to extend reach
    const botEyeY = (this._bot.entity?.position?.y ?? 0) + 1.62
    const logAbove = fresh.position.y + 0.5 > botEyeY + 0.5
    if (logAbove && typeof this._bot.setControlState === 'function') {
      this._bot.setControlState('jump', true)
    }
    try {
      if (typeof this._bot.lookAt === 'function') {
        await this._bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true)
      }
      const digPromise = this._bot.dig(fresh)
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), 8000))
      await Promise.race([digPromise, timeout])
    } catch (e) {
      if (typeof this._bot.setControlState === 'function') this._bot.setControlState('jump', false)
      this._warn(`dig failed: ${e?.message}`)
      this._failed.set(blockKey, Date.now())
      await sleep(DIG_FAIL_COOLDOWN_MS)
      this.state = 'SELECT_LOG'
      return
    }

    if (typeof this._bot.setControlState === 'function') {
      this._bot.setControlState('jump', false)
    }
    this._info(`dug ${blockKey}`)
    this._telemetry.logsDigged++
    // Remove dug log from pre-scan cache
    if (this._trunkLogs) this._trunkLogs.shift()
    this._currentLog = null
    // Increment progress counter without navigating to drop now — collect sweep at COMPLETE_TREE
    try { if (this._onBlockCollected) this._onBlockCollected() } catch (_) {}
    this.state = 'SELECT_LOG'
  }

  // ---------------------------------------------------------------------------
  // COLLECT: end-of-tree sweep — pick up all nearby drops in one pass
  // ---------------------------------------------------------------------------
  async _stateCollect () {
    await sleep(this._dropsWaitMs)
    if (!this._alive()) return
    // Navigate to each nearby drop entity until none remain within radius
    const visited = new Set()
    const MAGNET_RANGE = 2.5
    for (let i = 0; i < 8; i++) {
      if (!this._alive()) return
      const drop = this._findNearbyDrop(visited)
      if (!drop?.position) break
      visited.add(drop.id)
      const botPos = this._bot.entity?.position
      const dist = botPos ? _dist3(botPos, drop.position) : Infinity
      if (dist <= MAGNET_RANGE) {
        await sleep(400)
      } else {
        const { x, y, z } = drop.position
        await this._navigateTo(x, y, z, 1)
        if (!this._alive()) return
        await sleep(400)
      }
    }
    this.state = 'COMPLETE_TREE'
  }

  // ---------------------------------------------------------------------------
  // COMPLETE_TREE: final drop sweep before handing control back
  // ---------------------------------------------------------------------------
  async _stateCompleteTree () {
    treeChoppedCount++
    _emitTreeJobDebug({ summary: `Tree completed: ${this._treePos.x},${this._treePos.z}` })
    
    await sleep(this._dropsWaitMs)
    if (!this._alive()) return
    const visited = new Set()
    const MAGNET_RANGE = 2.5
    for (let i = 0; i < 16; i++) {
      if (!this._alive()) return
      const drop = this._findNearbyDrop(visited)
      if (!drop?.position) break
      visited.add(drop.id)
      const botPos = this._bot.entity?.position
      const dist = botPos ? _dist3(botPos, drop.position) : Infinity
      if (dist <= MAGNET_RANGE) {
        await sleep(400) // already in magnet range — auto-pickup
      } else {
        const { x, y, z } = drop.position
        await this._navigateTo(x, y, z, 1)
        if (!this._alive()) return
        await sleep(400)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Mark current log failed, transition to FAIL_TREE */
  _fail_log () {
    this._telemetry.failedLogs++
    if (this._currentLog) {
      this._failed.set(_bk(this._currentLog.position), Date.now())
      this._warn(`marking log failed: ${_bk(this._currentLog.position)}`)
    }
    // If this was the only log, fail tree; otherwise try next log
    const remaining = this._getLowestTrunkLog()
    if (!remaining) {
      treeFailedCount++
      _emitTreeJobDebug({ summary: `Tree failed: ${_bk(this._treePos)}` })
      this.state = 'FAIL_TREE'
    } else {
      this.state = 'SELECT_LOG'
    }
  }

  /** Get lowest unfailed log block at locked X,Z */
  _getLowestTrunkLog () {
    if (!this._bot.findBlocks) {
      // Legacy / test fallback
      // First: re-validate _currentLog if we already have one
      if (this._currentLog) {
        const bk = _bk(this._currentLog.position)
        if (!this._failed.has(bk)) {
          // Re-read the block to see if it still exists
          const fresh = this._bot.blockAt?.(this._currentLog.position)
          if (fresh && LOG_NAME_RE.test(fresh.name)) return fresh
        }
        // currentLog is gone or failed — fall through to findBlock
      }
      if (!this._bot.findBlock) return null
      const b = this._bot.findBlock({
        matching: (blk) => blk != null && LOG_NAME_RE.test(blk.name),
        maxDistance: 32
      })
      if (!b) return null
      if (this._failed.has(_bk(b.position))) return null
      // Only return if it matches the locked trunk X,Z
      if (b.position.x !== this._lock.tx || b.position.z !== this._lock.tz) return null
      return b
    }
    const { tx, tz } = this._lock
    const positions = this._bot.findBlocks({
      matching: (b) => b != null && LOG_NAME_RE.test(b.name),
      maxDistance: 32,
      count: 64
    })
    const trunk = positions
      .filter(p => p.x === tx && p.z === tz && !this._failed.has(_bk(p)))
      .sort((a, b) => a.y - b.y)
    if (trunk.length === 0) return null
    return this._bot.blockAt?.(trunk[0]) || null
  }

  /**
   * Scan all log positions on the locked trunk sorted lowest-first.
   * Used for pre-scan cache in SELECT_LOG.
   * @returns {Array<{x:number,y:number,z:number}>}
   */
  _scanTrunkLogs () {
    const { tx, tz } = this._lock
    if (!this._bot.findBlocks) {
      // Legacy fallback: just return currentLog position if valid
      if (this._currentLog && LOG_NAME_RE.test(this._currentLog.name)) {
        return [this._currentLog.position]
      }
      return []
    }
    const positions = this._bot.findBlocks({
      matching: (b) => b != null && LOG_NAME_RE.test(b.name),
      maxDistance: 32,
      count: 64
    })
    return positions
      .filter(p => p.x === tx && p.z === tz && !this._failed.has(_bk(p)))
      .sort((a, b) => a.y - b.y)
  }

  /**
   * Generate and score candidate dig spots around a log position.
   * Heuristic checks: solid floor, headroom (2 blocks), reach to log.
   * Score = reach_bonus + height_bonus - distance_from_bot.
   * @param {{ x:number, y:number, z:number }} logPos
   * @returns {Array<{x:number,y:number,z:number,score:number}>} sorted descending
   */
  _scoreCandidateSpots (logPos) {
    const bot = this._bot
    const botPos = bot.entity?.position
    const candidates = []

    for (const [dx, dy, dz] of SPOT_SCAN_OFFSETS) {
      const sx = logPos.x + dx
      const sy = logPos.y + dy
      const sz = logPos.z + dz

      // floor check: reject only true air/fluid below (bot can stand on leaves or partial blocks)
      const floor = bot.blockAt?.(new Vec3(sx, sy - 1, sz))
      if (!floor) continue
      const isLeafFloor = LEAVES_RE.test(floor.name)
      if (!isLeafFloor && floor.boundingBox === 'empty') continue

      // headroom: both body and head clear
      const body = bot.blockAt?.(new Vec3(sx, sy, sz))
      const head = bot.blockAt?.(new Vec3(sx, sy + 1, sz))
      if (body?.boundingBox === 'block') continue
      if (head?.boundingBox === 'block') continue

      // reach check: centre of standing pos to centre of log
      const reach = Math.sqrt(
        (sx + 0.5 - (logPos.x + 0.5)) ** 2 +
        (sy + 1 - (logPos.y + 0.5)) ** 2 +  // eye level ≈ y+1
        (sz + 0.5 - (logPos.z + 0.5)) ** 2
      )
      if (reach > DIG_REACH) continue

      // Not a failed block key itself
      if (this._failed.has(_bk({ x: sx, y: sy, z: sz }))) continue

      // Score: prefer low reach, prefer same Y as bot, penalise distance from bot
      const distBot = botPos
        ? Math.sqrt((sx - botPos.x) ** 2 + (sy - botPos.y) ** 2 + (sz - botPos.z) ** 2)
        : 0
      const score = (DIG_REACH - reach) * 3 - distBot + (dy === 0 ? 1 : 0)
      candidates.push({ x: sx, y: sy, z: sz, score })
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates
  }

  /**
   * Short nav probe: emit nav:goto, wait up to 2.5s, return true if arrived.
   * Used to validate top-2 candidates without committing to full nav.
   */
  async _probeNavSpot (spot, timeoutMs = 2500) {
    this._telemetry.navProbeCount++
    const { x, y, z } = spot
    this._bus.emit(NavEvents.GOTO, { kind: 'near', x, y, z, range: SPOT_NAV_RANGE, at: Date.now() })
    const deadline = Date.now() + timeoutMs
    let prevPartial = this._partialCount
    await sleep(this._navPollMs)
    while (Date.now() < deadline && this._alive()) {
      if (this._shouldInterrupt()) return false
      const pos = this._bot.entity?.position
      if (pos) {
        const d = _dist3(pos, { x, y, z })
        if (d <= SPOT_NAV_RANGE + 0.8) return true
      }
      // If we're getting lots of partials very quickly, this spot is bad
      if (this._partialCount - prevPartial >= 3) return false
      await sleep(this._navPollMs)
    }
    // Stop pathfinder after probe
    this._bus.emit(NavEvents.STOP, { reason: 'probe_end', at: Date.now() })
    return false
  }

  /**
   * Full navigate to (x,y,z). Stall detection with early-arrive on close dist.
   * @returns {Promise<boolean>}
   */
  async _navigateTo (x, y, z, range = SPOT_NAV_RANGE) {
    this._bus.emit(NavEvents.GOTO, { kind: 'near', x, y, z, range, at: Date.now() })
    const deadline = Date.now() + NAV_TIMEOUT_MS
    let lastProgressAt = Date.now()
    let lastDist = Infinity
    this._partialCount = 0

    await sleep(this._navPollMs)
    while (Date.now() < deadline && this._alive()) {
      if (this._shouldInterrupt()) return false
      const pos = this._bot.entity?.position
      if (!pos) break
      const dist = _dist3(pos, { x, y, z })
      if (dist <= range + 0.5) return true

      if (dist < lastDist - 0.3) { lastDist = dist; lastProgressAt = Date.now() }

      if (Date.now() - lastProgressAt > NAV_STALL_MS) {
        // Close enough to dig even if stalled — treat as arrived
        if (dist <= DIG_REACH) return true
        return false
      }
      // Excess partial spam on this spot — give up early
      if (this._partialCount >= PARTIAL_LIMIT) return false

      await sleep(this._navPollMs)
    }
    return false
  }

  /**
   * Clear leaf blocks between bot position and the log, and around the spot.
   * Targeted: only leaves within LEAF_CLEAR_RADIUS of the log, sorted by proximity to bot.
   * @param {{ x:number, y:number, z:number }} logPos
   */
  async _clearTargetedBlockers (logPos) {
    if (!this._bot.findBlocks) return
    const botPos = this._bot.entity?.position
    const leavesNearLog = this._bot.findBlocks({
      matching: (b) => b != null && LEAVES_RE.test(b.name),
      maxDistance: 4,
      count: MAX_LEAF_CLEAR
    }).filter(p => {
      // Only leaves that are between bot and log (within a bounding column + radius)
      const minX = Math.min(logPos.x, botPos?.x ?? logPos.x) - 1
      const maxX = Math.max(logPos.x, botPos?.x ?? logPos.x) + 1
      const minZ = Math.min(logPos.z, botPos?.z ?? logPos.z) - 1
      const maxZ = Math.max(logPos.z, botPos?.z ?? logPos.z) + 1
      return p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ
    })

    if (leavesNearLog.length === 0) return

    if (botPos) leavesNearLog.sort((a, b) => _dist3(botPos, a) - _dist3(botPos, b))

    this._info(`clearing ${leavesNearLog.length} targeted blocker leaves`)
    for (const lp of leavesNearLog) {
      if (!this._alive()) return
      const leaf = this._bot.blockAt?.(lp)
      if (!leaf || !LEAVES_RE.test(leaf.name)) continue
      try {
        if (typeof this._bot.lookAt === 'function') {
          await this._bot.lookAt(leaf.position.offset(0.5, 0.5, 0.5), true)
        }
        await this._bot.dig(leaf)
      } catch (_) {}
      await sleep(80)
    }
  }

  _findNearbyDrop (visited) {
    const pos = this._bot.entity?.position
    if (!pos || !this._bot.entities) return null
    let best = null; let bestDist = DROP_COLLECT_RADIUS
    for (const e of Object.values(this._bot.entities)) {
      if (!e.position || !e.isValid || e.name !== 'item') continue
      if (visited && visited.has(e.id)) continue
      const d = _dist3(pos, e.position)
      if (d < bestDist) { bestDist = d; best = e }
    }
    return best
  }

  _info (msg) { try { this._log?.info('[TreeJob]', msg) } catch (_) {} }
  _warn (msg) { try { this._log?.warn('[TreeJob]', msg) } catch (_) {} }
}

/** @param {{ x:number, y:number, z:number }} p */
function _bk (p) { return `${p.x},${p.y},${p.z}` }

/** Plain-object-safe 3D distance (works for Vec3 and plain {x,y,z}). */
function _dist3 (a, b) {
  const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

module.exports = { TreeJob, LOG_NAME_RE, LEAVES_RE, _bk }
