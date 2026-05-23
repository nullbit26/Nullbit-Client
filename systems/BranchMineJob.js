'use strict'

const { Vec3 } = require('vec3')
const { NavEvents } = require('../core/EventRegistry')
const { BaseJob } = require('./BaseJob')
const { equipBestPickaxe } = require('../utils/equipBestTool')
const { dropJunk, shouldDropJunk } = require('../utils/InventoryManager')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Optimal Y-levels for branch mining per ore type (1.18+ generation) */
const BRANCH_Y_TARGETS = Object.freeze({
  diamond:  -59,
  redstone: -59,
  lapis:      0,
  gold:     -16,
  iron:      16,
  copper:    48,
  coal:      96,
  emerald:  232
})

/** Length of each branch tunnel (blocks) */
const BRANCH_LENGTH = Number(process.env.BRANCH_LENGTH) || 32
/** Spacing between parallel branches (blocks) — 4 = optimal coverage with no overlap */
const BRANCH_SPACING = 4
/** Max branches per session before giving up */
const MAX_BRANCHES = Number(process.env.MAX_BRANCHES) || 8
/** Scan radius for ore detection after each branch step */
const ORE_SCAN_RADIUS = Number(process.env.ORE_SCAN_RADIUS) || 6
/** Time to hold forward per tunnel step (ms) */
const STEP_MS = 380
/** Settle after step (ms) */
const SETTLE_MS = 120
/** Nav timeout to reach branch start (ms) */
const NAV_TIMEOUT_MS = 30_000
/** Nav poll interval (ms) */
const NAV_POLL_MS = 200
/** Dig timeout per block (ms) */
const DIG_TIMEOUT_MS = 5_000
/** Place a torch every N steps */
const TORCH_INTERVAL = Number(process.env.TORCH_INTERVAL) || 8

/** Blocks that signal danger — abort tunnel */
const DANGER_RE = /^(lava|flowing_lava|water|flowing_water)$/
/** Gravity blocks */
const GRAVITY_RE = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|concrete_powder)$/

/** @param {number} ms */
const sleep = ms => new Promise(r => setTimeout(r, ms))

function _dist3 (a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

// ---------------------------------------------------------------------------
// BranchMineJob
// ---------------------------------------------------------------------------

/**
 * BranchMineJob — deterministic branch-mining at optimal Y-level for a given ore.
 *
 * FSM:
 *   PLAN_BRANCH  — pick next branch start position, emit NAV_GOTO
 *   NAV_TO_START — wait until bot reaches branch start
 *   DIG_BRANCH   — dig BRANCH_LENGTH blocks forward, scan sides for ore each step
 *   NEXT_BRANCH  — move to next branch (offset by BRANCH_SPACING)
 *   COMPLETE / FAIL
 *
 * On each DIG_BRANCH step, scans 3 blocks left and right — if ore found, digs it
 * and returns to branch axis before continuing.
 *
 * Designed as a fallback when CaveExplorerJob fails and shaft mining would be too
 * destructive. BranchMineJob is more systematic and surface-independent.
 */
class BranchMineJob extends BaseJob {
  /**
   * @param {{
   *   bot: import('mineflayer').Bot,
   *   bus: import('../core/EventBus').EventBus,
   *   oreName: string,
   *   blockMatcher: RegExp,
   *   dropMatcher: RegExp,
   *   logger?: any,
   *   shouldInterrupt?: () => boolean,
   *   navPollMs?: number,
   *   targetY?: number,
   *   branchLength?: number,
   *   maxBranches?: number,
   *   onBlockCollected?: () => void
   * }} opts
   * @param {() => boolean} alive
   */
  constructor (opts, alive) {
    super()
    this._bot       = opts.bot
    this._bus       = opts.bus
    this._name      = opts.oreName || 'ore'
    this._match     = opts.blockMatcher
    this._dropMatch = opts.dropMatcher || opts.blockMatcher
    this._log       = opts.logger || null
    this._interrupt = opts.shouldInterrupt || (() => false)
    this._alive     = alive
    this._poll      = opts.navPollMs ?? NAV_POLL_MS
    this._onCollected = opts.onBlockCollected || null

    // Determine target Y — caller can override, else use table
    this._targetY = opts.targetY != null
      ? Math.floor(Number(opts.targetY))
      : (BRANCH_Y_TARGETS[this._name] ?? 16)

    this._branchLength = Math.max(4, Math.floor(Number(opts.branchLength) || BRANCH_LENGTH))
    this._maxBranches  = Math.max(1, Math.floor(Number(opts.maxBranches)  || MAX_BRANCHES))

    // Runtime state
    /** @type {'PLAN_BRANCH'|'NAV_TO_START'|'DIG_BRANCH'|'NEXT_BRANCH'|'COMPLETE'|'FAIL'} */
    this.state = 'PLAN_BRANCH'

    this._branchIndex  = 0     // how many branches done
    this._blocksDigged = 0
    this._startPos     = null  // bot position when mining started (reference for branch offsets)
    this._branchDir    = null  // { dx, dz } unit direction for current branch
    this._branchOrigin = null  // Vec3 start of current branch
  }

  destroy () {}

  get metrics () {
    return {
      jobType: 'branch_mine',
      oreName: this._name,
      targetY: this._targetY,
      branchIndex: this._branchIndex,
      blocksDigged: this._blocksDigged
    }
  }

  // ---------------------------------------------------------------------------
  async run () {
    this._info(`starting branch mining for ${this._name} at Y=${this._targetY}`)

    // Capture initial bot position as reference point for branch offsets
    const initPos = this._bot.entity?.position
    if (!initPos) return 'fail'
    this._startPos = initPos.clone()

    // Pick initial direction based on bot yaw (face direction)
    const yaw = this._bot.entity?.yaw ?? 0
    this._branchDir = _yawToDir(yaw)

    try { await equipBestPickaxe(this._bot) } catch (_) {}

    while (this._alive()) {
      if (this._interrupt()) return 'interrupted'
      switch (this.state) {
        case 'PLAN_BRANCH':    await this._statePlanBranch();  break
        case 'NAV_TO_START':   await this._stateNavToStart();  break
        case 'DIG_BRANCH':     await this._stateDigBranch();   break
        case 'NEXT_BRANCH':    await this._stateNextBranch();  break
        case 'COMPLETE':       return 'complete'
        case 'FAIL':           return 'fail'
        default:               return 'fail'
      }
    }
    return 'interrupted'
  }

  // ---------------------------------------------------------------------------
  // PLAN_BRANCH — compute the start position of the next branch
  // ---------------------------------------------------------------------------
  async _statePlanBranch () {
    if (this._branchIndex >= this._maxBranches) {
      this._info(`all ${this._maxBranches} branches done`)
      this.state = 'COMPLETE'
      return
    }

    const bot = this._bot
    const pos = bot.entity?.position
    if (!pos) { this.state = 'FAIL'; return }

    // Branch starts at current position (first branch) or offset perpendicular
    // after each subsequent branch. Perpendicular = rotate branchDir 90°.
    const perp = _perpDir(this._branchDir)
    const offsetBlocks = this._branchIndex * BRANCH_SPACING

    // Use actual bot Y (already at correct depth after shaft dig) rather than
    // hardcoded targetY — avoids pathfinder trying to navigate through solid rock.
    const floorY = Math.floor(this._startPos.y)
    this._branchOrigin = new Vec3(
      Math.floor(this._startPos.x + perp.dx * offsetBlocks) + 0.5,
      floorY,
      Math.floor(this._startPos.z + perp.dz * offsetBlocks) + 0.5
    )

    this._info(
      `branch #${this._branchIndex + 1}/${this._maxBranches}` +
      ` start=(${Math.floor(this._branchOrigin.x)},${Math.floor(this._branchOrigin.y)},${Math.floor(this._branchOrigin.z)})` +
      ` dir=(${this._branchDir.dx},${this._branchDir.dz})`
    )

    this.state = 'NAV_TO_START'
  }

  // ---------------------------------------------------------------------------
  // NAV_TO_START — navigate to branch start position
  // ---------------------------------------------------------------------------
  async _stateNavToStart () {
    const origin = this._branchOrigin
    if (!origin) { this.state = 'FAIL'; return }

    // If already close enough, skip navigation
    const pos = this._bot.entity?.position
    if (pos && _dist3(pos, origin) <= 3) {
      this.state = 'DIG_BRANCH'
      return
    }

    this._bus.emit(NavEvents.GOTO, {
      kind: 'near',
      x: origin.x, y: origin.y, z: origin.z,
      range: 2
    })

    const deadline = Date.now() + NAV_TIMEOUT_MS
    while (this._alive() && Date.now() < deadline) {
      if (this._interrupt()) return
      await sleep(this._poll)
      const cur = this._bot.entity?.position
      if (!cur) continue
      if (_dist3(cur, origin) <= 3) break
    }

    this._bus.emit(NavEvents.STOP, { reason: 'branch_arrived' })
    this.state = 'DIG_BRANCH'
  }

  // ---------------------------------------------------------------------------
  // DIG_BRANCH — dig forward BRANCH_LENGTH blocks, scan sides each step
  // ---------------------------------------------------------------------------
  async _stateDigBranch () {
    const bot   = this._bot
    const dir   = this._branchDir

    for (let step = 0; step < this._branchLength; step++) {
      if (!this._alive() || this._interrupt()) return

      // Inventory check
      if (shouldDropJunk(bot, 0.85)) {
        await dropJunk(bot, { targetFreeSlots: 6, logger: this._log })
      }

      const pos = bot.entity?.position
      if (!pos) break

      // Compute target block in front (feet level and head level — 1×2 tunnel)
      const fx = Math.floor(pos.x) + dir.dx
      const fz = Math.floor(pos.z) + dir.dz
      const fy = Math.floor(pos.y) // feet

      // Safety check ahead
      const danger = this._checkDanger(fx, fy, fz)
      if (danger) {
        this._info(`danger ahead: ${danger} — stopping branch`)
        break
      }

      // Dig 1×2 column ahead (feet + head)
      await this._digColumn(fx, fy, fz)
      if (!this._alive() || this._interrupt()) return

      // Scan sides for ore (3 blocks left and right)
      await this._scanSides(fx, fy, fz)
      if (!this._alive() || this._interrupt()) return

      // Place torch periodically
      if (step > 0 && step % TORCH_INTERVAL === 0) {
        this._tryPlaceTorch()
      }

      // Move forward
      bot.setControlState('forward', true)
      await sleep(STEP_MS)
      bot.setControlState('forward', false)
      await sleep(SETTLE_MS)
    }

    this.state = 'NEXT_BRANCH'
  }

  // ---------------------------------------------------------------------------
  // NEXT_BRANCH — increment branch counter, return to start reference
  // ---------------------------------------------------------------------------
  async _stateNextBranch () {
    this._branchIndex++
    if (this._branchIndex >= this._maxBranches) {
      this._info('all branches exhausted')
      this.state = 'COMPLETE'
      return
    }

    // Navigate back toward start reference to prepare for next parallel branch
    const refPos = this._startPos
    if (refPos) {
      const refY = Math.floor(refPos.y)
      this._bus.emit(NavEvents.GOTO, {
        kind: 'near',
        x: refPos.x, y: refY, z: refPos.z,
        range: 4
      })
      const deadline = Date.now() + NAV_TIMEOUT_MS
      while (this._alive() && Date.now() < deadline) {
        if (this._interrupt()) return
        await sleep(this._poll)
        const cur = this._bot.entity?.position
        if (!cur) continue
        if (_dist3(cur, { x: refPos.x, y: refY, z: refPos.z }) <= 5) break
      }
      this._bus.emit(NavEvents.STOP, { reason: 'return_to_origin' })
    }

    this.state = 'PLAN_BRANCH'
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Dig a 1×2 column (feet + head) at (x, y, z).
   * Skips air and unbreakable blocks.
   */
  async _digColumn (x, y, z) {
    for (const dy of [0, 1]) {
      if (!this._alive() || this._interrupt()) return
      const blk = this._bot.blockAt?.(new Vec3(x, y + dy, z))
      if (!blk || blk.boundingBox === 'empty') continue
      if (/^(bedrock|barrier|command_block)$/.test(blk.name)) continue
      // Handle gravity blocks above — pre-dig to avoid cave-in
      if (dy === 0 && GRAVITY_RE.test(blk.name)) {
        await this._safeDigBlock(blk)
        continue
      }
      await this._safeDigBlock(blk)
    }
  }

  /**
   * Scan 3 blocks left and right of the current position.
   * If ore found, dig toward it and return to branch axis.
   */
  async _scanSides (branchX, branchY, branchZ) {
    const perp = _perpDir(this._branchDir)
    for (const side of [1, -1]) {
      for (let reach = 1; reach <= 3; reach++) {
        if (!this._alive() || this._interrupt()) return
        const sx = branchX + perp.dx * side * reach
        const sz = branchZ + perp.dz * side * reach
        // Check feet and head level
        for (const dy of [0, 1]) {
          const blk = this._bot.blockAt?.(new Vec3(sx, branchY + dy, sz))
          if (!blk) continue
          if (this._match.test(blk.name)) {
            this._info(`ore detected: ${blk.name} at (${sx},${branchY + dy},${sz})`)
            // Dig the intermediate column to reach it
            for (let r = 1; r <= reach; r++) {
              const ix = branchX + perp.dx * side * r
              const iz = branchZ + perp.dz * side * r
              await this._digColumn(ix, branchY, iz)
              if (!this._alive()) return
            }
            // Dig the ore itself
            await this._safeDigBlock(blk)
            if (this._onCollected) this._onCollected()
            this._blocksDigged++
            // Return to branch axis — re-dig the column we made
            for (let r = reach - 1; r >= 1; r--) {
              const ix = branchX + perp.dx * side * r
              const iz = branchZ + perp.dz * side * r
              await this._digColumn(ix, branchY, iz)
              if (!this._alive()) return
            }
            break // found ore on this side — stop scanning further
          }
        }
      }
    }
  }

  /** Safely dig a single block with timeout */
  async _safeDigBlock (block) {
    try {
      const deadline = Date.now() + DIG_TIMEOUT_MS
      await Promise.race([
        this._bot.dig(block),
        new Promise((_, reject) => setTimeout(() => reject(new Error('dig timeout')), DIG_TIMEOUT_MS))
      ])
      this._blocksDigged++
      if (this._match.test(block.name) && this._onCollected) this._onCollected()
    } catch (_) {}
    await sleep(80)
  }

  /** Check for danger (lava/water) in a 1×2 column ahead */
  _checkDanger (x, y, z) {
    for (const dy of [0, 1, -1]) {
      const blk = this._bot.blockAt?.(new Vec3(x, y + dy, z))
      if (blk && DANGER_RE.test(blk.name)) return blk.name
    }
    return null
  }

  /** Place a torch on the floor or wall if available */
  _tryPlaceTorch () {
    try {
      const torch = this._bot.inventory?.items?.()?.find(i => i?.name === 'torch')
      if (!torch) return
      const pos = this._bot.entity?.position
      if (!pos) return
      const floorPos = new Vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z))
      const floor = this._bot.blockAt?.(floorPos)
      if (floor && floor.boundingBox !== 'empty') {
        // fire-and-forget — don't await to avoid blocking tunnel
        this._bot.placeBlock(floor, new Vec3(0, 1, 0)).catch(() => {})
      }
    } catch (_) {}
  }

  _info (...args) {
    try { this._log?.info?.('[BranchMineJob]', ...args) } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Direction helpers
// ---------------------------------------------------------------------------

/** Convert bot yaw (radians) to nearest cardinal {dx, dz} */
function _yawToDir (yaw) {
  // Minecraft yaw: 0 = south (+z), π/2 = west (-x), π = north (-z), 3π/2 = east (+x)
  const deg = ((yaw * 180 / Math.PI) % 360 + 360) % 360
  if (deg < 45 || deg >= 315) return { dx: 0, dz: 1 }  // south
  if (deg < 135) return { dx: -1, dz: 0 }               // west
  if (deg < 225) return { dx: 0, dz: -1 }               // north
  return { dx: 1, dz: 0 }                               // east
}

/** Rotate direction 90° clockwise → perpendicular */
function _perpDir (dir) {
  return { dx: dir.dz, dz: -dir.dx }
}

module.exports = { BranchMineJob, BRANCH_Y_TARGETS, BRANCH_LENGTH, BRANCH_SPACING, MAX_BRANCHES }
