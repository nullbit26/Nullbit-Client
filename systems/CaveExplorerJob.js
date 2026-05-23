'use strict'

const { Vec3 } = require('vec3')
const { NavEvents } = require('../core/EventRegistry')
const { BaseJob } = require('./BaseJob')

/** Radius to search for cave openings (air pockets underground) */
const CAVE_SCAN_RADIUS = 48
/** Minimum depth below bot Y to consider as "underground" */
const MIN_UNDERGROUND_DEPTH = 3
/** Nav timeout to reach cave entrance (ms) */
const NAV_TIMEOUT_MS = 20_000
/** Nav poll interval (ms) */
const NAV_POLL_MS = 200
/** Minimum air pocket volume to qualify as a cave (adjacent air count) */
const MIN_AIR_CLUSTER = 4
/** How far bot must travel to count as "explored" (blocks) */
const MIN_EXPLORE_DIST = 8
/** How long to remember a visited cave before allowing revisit (ms) — 25 minutes */
const CAVE_VISITED_TTL_MS = 25 * 60 * 1000

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 */
function _dist3 (a, b) {
  const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * CaveExplorerJob — navigates bot to the nearest underground cave opening.
 * Used as a fallback by ResourceSystem when no ore is visible in loaded chunks.
 * After arriving, ResourceSystem re-scans for ore from the new position.
 *
 * FSM: SCAN_CAVE → NAV_TO_CAVE → (complete | fail)
 */
class CaveExplorerJob extends BaseJob {
  /**
   * @param {{
   *   bot: import('mineflayer').Bot,
   *   bus: import('../core/EventBus').EventBus,
   *   logger?: any,
   *   shouldInterrupt?: () => boolean,
   *   navPollMs?: number,
   *   visitedCaves?: Set<string>
   * }} opts
   * @param {() => boolean} alive
   */
  constructor (opts, alive) {
    super()
    this._bot = opts.bot
    this._bus = opts.bus
    this._log = opts.logger || null
    this._shouldInterrupt = opts.shouldInterrupt || (() => false)
    this._navPollMs = opts.navPollMs ?? NAV_POLL_MS
    /** Shared map of cave key → visitedAt timestamp */
    this._visited = opts.visitedCaves || new Map()
    this._alive = alive

    /** @type {'SCAN_CAVE'|'NAV_TO_CAVE'|'COMPLETE'|'FAIL'} */
    this.state = 'SCAN_CAVE'
    this._target = null
  }

  /** @override */
  destroy () {}

  /** @override */
  get metrics () { return { jobType: 'cave_explore' } }

  /** @override */
  async run () {
    while (this._alive()) {
      if (this._shouldInterrupt()) return 'interrupted'
      switch (this.state) {
        case 'SCAN_CAVE':    await this._stateScanCave(); break
        case 'NAV_TO_CAVE':  await this._stateNavToCave(); break
        case 'COMPLETE':     return 'complete'
        case 'FAIL':         return 'fail'
        default:             return 'fail'
      }
    }
    return 'interrupted'
  }

  // ---------------------------------------------------------------------------
  // SCAN_CAVE — find nearest underground air pocket not yet visited
  // ---------------------------------------------------------------------------
  async _stateScanCave () {
    const bot = this._bot
    const botPos = bot.entity?.position
    if (!botPos) { this.state = 'FAIL'; return }

    if (!bot.findBlocks) { this.state = 'FAIL'; return }

    // Scan for air blocks significantly below current Y
    const airPositions = bot.findBlocks({
      matching: (blk) => {
        if (!blk) return false
        // Air or cave_air below bot
        if (blk.name !== 'air' && blk.name !== 'cave_air') return false
        return true
      },
      maxDistance: CAVE_SCAN_RADIUS,
      count: 256
    })

    // Filter: must be underground (below bot - MIN_UNDERGROUND_DEPTH),
    // have solid floor, and not already visited
    const candidates = []
    for (const p of airPositions) {
      if (p.y >= botPos.y - MIN_UNDERGROUND_DEPTH) continue

      const key = `${p.x},${p.y},${p.z}`
      const visitedAt = this._visited.get(key)
      if (visitedAt && Date.now() - visitedAt < CAVE_VISITED_TTL_MS) continue

      // Must have solid floor below
      const floor = bot.blockAt?.(new Vec3(p.x, p.y - 1, p.z))
      if (!floor || floor.boundingBox === 'empty') continue

      // Must have air above too (headroom = 1x2 tunnel at minimum)
      const head = bot.blockAt?.(new Vec3(p.x, p.y + 1, p.z))
      if (!head || head.boundingBox !== 'empty') continue

      // Count adjacent air to ensure it's a real cave pocket, not a 1-block gap
      let airNeighbors = 0
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = bot.blockAt?.(new Vec3(p.x + dx, p.y, p.z + dz))
        if (nb && nb.boundingBox === 'empty') airNeighbors++
      }
      if (airNeighbors < MIN_AIR_CLUSTER - 3) continue // at least 1 neighbor

      const dist = _dist3(p, botPos)
      candidates.push({ p, dist, key })
    }

    if (candidates.length === 0) {
      this._info('no cave entrance found within', CAVE_SCAN_RADIUS, 'blocks')
      this.state = 'FAIL'
      return
    }

    // Pick closest cave entrance
    candidates.sort((a, b) => a.dist - b.dist)
    const best = candidates[0]
    this._target = best.p
    this._info(`cave entrance found at (${best.p.x},${best.p.y},${best.p.z}) dist=${Math.round(best.dist)}`)
    this.state = 'NAV_TO_CAVE'
  }

  // ---------------------------------------------------------------------------
  // NAV_TO_CAVE — navigate to the cave entrance
  // ---------------------------------------------------------------------------
  async _stateNavToCave () {
    const target = this._target
    if (!target) { this.state = 'FAIL'; return }

    const startPos = this._bot.entity?.position
    if (!startPos) { this.state = 'FAIL'; return }

    this._bus.emit(NavEvents.GOTO, {
      kind: 'near',
      x: target.x,
      y: target.y,
      z: target.z,
      range: 2
    })

    const deadline = Date.now() + NAV_TIMEOUT_MS
    while (this._alive() && Date.now() < deadline) {
      if (this._shouldInterrupt()) return
      await sleep(this._navPollMs)
      const pos = this._bot.entity?.position
      if (!pos) continue
      if (_dist3(pos, target) <= 3) break
    }

    this._bus.emit(NavEvents.STOP, { reason: 'cave_arrived' })

    const endPos = this._bot.entity?.position
    const traveled = startPos && endPos ? _dist3(startPos, endPos) : 0

    // Always mark cave as visited (even on fail) so it's not retried this session
    this._visited.set(`${target.x},${target.y},${target.z}`, Date.now())

    if (traveled < MIN_EXPLORE_DIST) {
      // If bot is already AT the cave (started close), count as complete
      const distToTarget = _dist3(this._bot.entity?.position ?? target, target)
      if (distToTarget <= 4) {
        this._info(`cave nav: already at entrance (dist=${distToTarget.toFixed(1)}) — complete`)
        this.state = 'COMPLETE'
        return
      }
      this._info(`cave nav: traveled only ${Math.round(traveled)} blocks — marking fail`)
      this.state = 'FAIL'
      return
    }

    this._info(`arrived at cave, traveled ${Math.round(traveled)} blocks`)
    this.state = 'COMPLETE'
  }

  /** @private */
  _info (...args) {
    try { this._log?.info?.('[CaveExplorerJob]', ...args) } catch (_) {}
  }
}

module.exports = { CaveExplorerJob }
