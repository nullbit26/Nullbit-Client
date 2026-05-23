'use strict'

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('../utils/sleep')
const { CoreEvents, CombatEvents, ResourceEvents, NavEvents, WatchdogEvents } = require('../core/EventRegistry')
const { CoreStates } = require('../core/StateManager')
const { equipBestPickaxe } = require('../utils/equipBestTool')

const NAV_TIMEOUT_MS = 180000 // 3 minutes to get home (may need to dig to surface first)
const NAV_POLL_MS = 500

/**
 * Home Base System V1
 * MVP: Interrupt -> Return Home -> Deposit -> Craft -> Resume
 * Single chest, no smelting, stone tools only
 */
class HomeBaseSystem {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('./HomeBaseConfig')} config
   * @param {import('./StorageSystem')} storage
   * @param {import('./CraftingSystem')} crafting
   * @param {import('../memory/BotBrain')} brain
   * @param {import('../Bus')} bus
   */
  constructor (bot, config, storage, crafting, brain, bus) {
    this._bot = bot
    this._config = config
    this._storage = storage
    this._crafting = crafting
    this._brain = brain
    this._bus = bus
    this._isRunning = false
    this._interruptedJob = null

    // Combat interrupt tracking
    this._navigating = false
    this._combatInterrupted = false
    this._gatherInterrupted = false
    this._pendingHomeReturn = false
    this._onStateChanged = this._onStateChanged.bind(this)
    this._onGatherStart = this._onGatherStart.bind(this)
    this._onWatchdogDeadlock = this._onWatchdogDeadlock.bind(this)

    // Wire to event bus
    this._bus.on(CoreEvents.STATE_CHANGED, this._onStateChanged)
    this._bus.on(ResourceEvents.GATHER_START, this._onGatherStart)
    this._bus.on(WatchdogEvents.DEADLOCK_DETECTED, this._onWatchdogDeadlock)
  }

  /**
   * Listen for combat state to interrupt navigation
   * @private
   */
  _onStateChanged (ev) {
    // If entering combat/flee while navigating home, mark as interrupted
    if (this._navigating && (ev.state === CoreStates.COMBAT || ev.state === CoreStates.FLEE)) {
      this._combatInterrupted = true
      this._log(`Navigation interrupted by ${ev.state}`)
    }
  }

  /**
   * If gather restarts while we're still navigating, abort nav loop immediately
   * @private
   */
  _onGatherStart () {
    if (this._navigating) {
      this._gatherInterrupted = true
      this._log('Navigation aborted — gather restarted externally')
    }
  }

  /**
   * Check if navigation should abort due to combat
   * @private
   * @returns {boolean}
   */
  _shouldAbortNavigation () {
    const currentState = this._brain?.state?.getState?.() || this._brain?.stateManager?.currentState
    return this._combatInterrupted ||
           this._gatherInterrupted ||
           currentState === CoreStates.COMBAT ||
           currentState === CoreStates.FLEE
  }

  /**
   * Main entry point: execute full round-trip to base
   * Called when inventory full, tool broken, or low resources
   * @param {{reason: string, previousJob: Object}} params
   * @returns {Promise<'success'|'fail'>}
   */
  async executeRoundTrip (params) {
    if (this._isRunning) {
      this._log('Already running, skip')
      return 'fail'
    }

    if (!this._config.isConfigured()) {
      this._log('ERROR: Base not configured! Use "тут база" command')
      return 'fail'
    }

    this._isRunning = true
    this._interruptedJob = params.previousJob || null
    this._combatInterrupted = false
    this._gatherInterrupted = false
    this._log(`Starting round-trip. Reason: ${params.reason}`)

    try {
      // 1. Navigate to base
      if (!(await this._navigateToBase())) {
        this._log('Failed to reach base')
        this._isRunning = false
        return 'fail'
      }

      // 1b. Scan for chests and crafting table in radius 25 — auto-discover new containers
      this._config.scanNearbyBase(this._bot, 25, './config/homebase.json')

      // 2. Deposit loot
      const deposit = await this._storage.depositAll()
      this._log(`Deposited ${deposit.deposited} items`)

      // 3. Check and craft needed tools
      const toolNeeds = this._crafting.checkToolNeeds()
      if (toolNeeds.needsPickaxe || toolNeeds.needsAxe) {
        // 3a. First craft planks from any logs in inventory (deposited wood)
        await this._crafting.craftPlanksFromLogs()

        // 3b. Withdraw planks + cobblestone from chests
        const needs = {
          planks: 2,
          cobblestone: 6 // 3 for pickaxe + 3 for axe
        }
        await this._storage.withdrawCraftingMaterials(needs)

        // 3c. If still no planks, try withdrawing logs from chests and converting them
        const planksInInv = this._bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0)
        if (planksInInv < 2) {
          await this._storage.withdrawLogs(2)
          await this._crafting.craftPlanksFromLogs()
        }

        // Craft
        const crafted = await this._crafting.craftMissingTools(toolNeeds)
        this._log(`Crafted: pickaxe=${crafted.pickaxe}, axe=${crafted.axe}`)
      }

      // 3d. Prepare mining supplies: crafting_table + sticks (for torches + spare pickaxes)
      // Need ~8 planks: 4 for table + ~5 for sticks. Pull logs from chest if needed.
      const planksNow = this._bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0)
      const logsNow = this._bot.inventory.items().filter(i => i.name.endsWith('_log')).reduce((s, i) => s + i.count, 0)
      if (planksNow + logsNow * 4 < 8) {
        await this._storage.withdrawLogs(4)
      }
      const minePrep = await this._crafting.prepareForMining()
      this._log(`Mining prep: table=${minePrep.table} sticks=${minePrep.sticks}`)

      // 4. Restock: take best tools, food, armor, torches from all chests
      await this._storage.restockForExpedition()

      // 4b. If still low on torches after chest search — craft from inventory
      const torchesAfterRestock = this._bot.inventory.items().find(i => i.name === 'torch')?.count ?? 0
      if (torchesAfterRestock < 16) {
        const crafted = await this._crafting.craftTorches(16)
        if (crafted > 0) this._log(`Torches: crafted ${crafted} (now ${torchesAfterRestock + crafted})`)
      }

      // 5. Brief pause at base
      await sleep(1000)

      this._log('Round-trip complete')
      this._isRunning = false
      return 'success'

    } catch (e) {
      this._log(`Round-trip failed: ${e.message}`)
      this._isRunning = false
      return 'fail'
    }
  }

  /**
   * Navigate to base — if underground, dig to surface first
   * @returns {Promise<boolean>}
   * @private
   */
  async _navigateToBase () {
    const chestPos = this._config.getChestPos()
    if (!chestPos) return false

    const botPos = this._bot.entity?.position
    this._log(`Navigating to chest: ${chestPos.x},${chestPos.y},${chestPos.z} from ${botPos ? botPos.x.toFixed(0) + ',' + botPos.y.toFixed(0) + ',' + botPos.z.toFixed(0) : 'unknown'}`)

    if (!this._bot.pathfinder || typeof this._bot.pathfinder.setGoal !== 'function') {
      this._log('ERROR: no pathfinder available')
      return false
    }

    // If bot is significantly underground (>10 blocks below target), dig to surface first
    if (botPos && chestPos.y - botPos.y > 10) {
      this._log(`Bot is ${(chestPos.y - botPos.y).toFixed(0)} blocks below target — digging to surface first`)
      await this._digToSurface(chestPos.y)
    }

    this._navigating = true
    this._arrived = false
    this._lastGotoAt = 0

    // Allow pathfinder to dig through blocks to escape mine
    try {
      if (this._bot.pathfinder.movements) {
        this._bot.pathfinder.movements.canDig = true
        this._bot.pathfinder.movements.digCost = 1
      }
    } catch (_) {}

    this._bus.emit(NavEvents.GOTO, {
      kind: 'near',
      x: chestPos.x,
      y: chestPos.y,
      z: chestPos.z,
      range: 2,
      force: true
    })
    this._log('nav:goto emitted (near chest)')

    const deadline = Date.now() + NAV_TIMEOUT_MS
    let lastDist = Infinity
    let stuckSince = 0
    let lastProgressDist = Infinity
    let lastProgressAt = Date.now()

    while (Date.now() < deadline) {
      if (this._shouldAbortNavigation()) {
        if (this._gatherInterrupted) {
          this._log('Navigation aborted — gather took over')
          this._bus.emit(NavEvents.STOP, { reason: 'gather_took_over' })
        } else {
          this._log('Navigation paused due to combat/flee')
          this._pendingHomeReturn = true
          this._bus.emit(NavEvents.STOP, { reason: 'combat_abort' })
        }
        this._navigating = false
        this._isRunning = false
        return false
      }

      const pos = this._bot.entity?.position
      if (pos) {
        const dx = pos.x - chestPos.x
        const dy = pos.y - chestPos.y
        const dz = pos.z - chestPos.z
        const dist3d = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (dist3d <= 3) {
          this._log(`Arrived at chest (dist ${dist3d.toFixed(1)})`)
          this._bus.emit(NavEvents.STOP, { reason: 'arrived_home' })
          this._pendingHomeReturn = false
          this._navigating = false
          return true
        }

        // Track real progress (any direction)
        if (dist3d < lastProgressDist - 2) {
          lastProgressDist = dist3d
          lastProgressAt = Date.now()
        }
        const noProgressMs = Date.now() - lastProgressAt

        // Stuck underground — dig up
        if (dist3d < lastDist - 1) {
          lastDist = dist3d
          stuckSince = Date.now()
        } else if (!stuckSince) {
          stuckSince = Date.now()
        }

        if (stuckSince && Date.now() - stuckSince > 15000 && pos.y < chestPos.y - 5) {
          this._log(`Stuck for 15s at dist=${dist3d.toFixed(1)} — digging up to surface`)
          this._bus.emit(NavEvents.STOP, { reason: 'stuck_digging_up' })
          await this._digToSurface(chestPos.y)
          stuckSince = Date.now()
          lastDist = Infinity
          lastProgressAt = Date.now()
          lastProgressDist = dist3d
          this._bus.emit(NavEvents.GOTO, {
            kind: 'near',
            x: chestPos.x,
            y: chestPos.y,
            z: chestPos.z,
            range: 2,
            force: true
          })
          continue
        }

        // Stuck on surface — pathfinder can't find path (terrain/water/etc)
        if (noProgressMs > 30000) {
          this._log(`No progress for 30s at dist=${dist3d.toFixed(1)} — forcing canDig+canSwim and re-routing`)
          try {
            if (this._bot.pathfinder?.movements) {
              this._bot.pathfinder.movements.canDig = true
              this._bot.pathfinder.movements.canSwim = true
              this._bot.pathfinder.movements.digCost = 1
              this._bot.pathfinder.movements.liquidCost = 1
            }
          } catch (_) {}
          this._bus.emit(NavEvents.STOP, { reason: 'stuck_surface_reroute' })
          await sleep(500)
          this._bus.emit(NavEvents.GOTO, {
            kind: 'near',
            x: chestPos.x,
            y: chestPos.y,
            z: chestPos.z,
            range: 2,
            force: true
          })
          lastProgressAt = Date.now() // reset — give it another 30s
          this._lastGotoAt = Date.now()

          // If still no progress after another 60s total, give up
          if (noProgressMs > 90000) {
            this._log(`No progress for 90s — giving up navigation`)
            this._bus.emit(NavEvents.STOP, { reason: 'nav_no_progress' })
            this._navigating = false
            return false
          }
          continue
        }

        // Re-emit goal every 6s
        const now = Date.now()
        if (!this._lastGotoAt || now - this._lastGotoAt > 6000) {
          this._lastGotoAt = now
          this._log(`re-emitting goto (dist ${dist3d.toFixed(1)})`)
          this._bus.emit(NavEvents.GOTO, {
            kind: 'near',
            x: chestPos.x,
            y: chestPos.y,
            z: chestPos.z,
            range: 2,
            force: true
          })
        }
      }

      await sleep(NAV_POLL_MS)
    }

    this._bus.emit(NavEvents.STOP, { reason: 'nav_timeout' })
    this._navigating = false
    this._log('Navigation timeout')
    return false
  }

  /**
   * Dig/pillar upward to reach target Y level.
   * Two modes:
   *   - Open space (cave): pillar up by placing blocks under feet
   *   - Solid rock: dig staircase through ceiling
   * @param {number} targetY
   * @private
   */
  async _digToSurface (targetY) {
    const bot = this._bot
    const MAX_STEPS = 300
    let lastY = Math.floor(bot.entity?.position?.y ?? 0)
    let stuckCount = 0

    this._log(`_digToSurface: starting from y=${lastY} to y=${targetY}`)
    try { await equipBestPickaxe(bot) } catch (_) {}

    for (let step = 0; step < MAX_STEPS; step++) {
      const pos = bot.entity?.position
      if (!pos) break
      if (pos.y >= targetY - 2) {
        this._log(`_digToSurface: reached target y=${pos.y.toFixed(0)} (target=${targetY}) in ${step} steps`)
        return
      }
      if (this._shouldAbortNavigation()) return

      const footY = Math.floor(pos.y)
      const bx = Math.floor(pos.x)
      const bz = Math.floor(pos.z)

      // Stuck detection
      if (footY === lastY) {
        stuckCount++
      } else {
        stuckCount = 0
        lastY = footY
      }
      if (stuckCount > 40) {
        this._log(`_digToSurface: stuck at y=${footY} for 40 steps — aborting`)
        return
      }

      // Direction toward chest (for staircase direction)
      const chestPos = this._config.getChestPos()
      const sdx = chestPos ? Math.sign(chestPos.x - pos.x) || 1 : 1
      const sdz = chestPos ? Math.sign(chestPos.z - pos.z) || 0 : 0
      const nx = bx + (Math.abs(sdx) >= Math.abs(sdz) ? sdx : 0)
      const nz = bz + (Math.abs(sdz) > Math.abs(sdx) ? sdz : 0)

      // Check if ceiling is solid (rock above head)
      const ceilingBlock = bot.blockAt(new Vec3(bx, footY + 2, bz))
      const ceilingIsSolid = ceilingBlock && ceilingBlock.boundingBox === 'block' &&
        ceilingBlock.name !== 'bedrock'

      // Also check if the forward+up block is solid (wall to dig into)
      const fwdBlock = bot.blockAt(new Vec3(nx, footY + 1, nz))
      const fwdIsSolid = fwdBlock && fwdBlock.boundingBox === 'block' &&
        fwdBlock.name !== 'bedrock'

      if (ceilingIsSolid || fwdIsSolid) {
        // MODE: DIG STAIRCASE — dig ceiling + forward blocks, jump-step up
        try { await equipBestPickaxe(bot) } catch (_) {}

        await this._digSolid(bx, footY + 2, bz)
        await this._digSolid(nx, footY + 1, nz)
        await this._digSolid(nx, footY + 2, nz)

        const yaw = Math.atan2(-(nx - bx), -(nz - bz))
        await bot.look(yaw, 0, true)
        bot.setControlState('jump', true)
        bot.setControlState('forward', true)
        await sleep(400)
        bot.setControlState('forward', false)
        bot.setControlState('jump', false)
        await sleep(150)
      } else {
        // MODE: OPEN CAVE — try pillar up first, fallback to walk-to-wall
        const scaffold = this._findScaffoldBlock()
        const wallDir = this._findNearbyWall(bx, footY, bz)

        if (scaffold) {
          // PILLAR UP: jump, place block on the block we were standing on
          try { await equipBestPickaxe(bot) } catch (_) {}
          await this._digSolid(bx, footY + 2, bz) // clear above head
          await this._digSolid(bx, footY + 3, bz)
          try { await bot.equip(scaffold, 'hand') } catch (_) {}

          // Snap to block center so bot doesn't clip adjacent blocks when jumping
          const centerX = bx + 0.5
          const centerZ = bz + 0.5
          const curPos = bot.entity?.position
          if (curPos) {
            const offX = centerX - curPos.x
            const offZ = centerZ - curPos.z
            const distToCenter = Math.sqrt(offX * offX + offZ * offZ)
            if (distToCenter > 0.2) {
              // Look toward center and step there
              const snapYaw = Math.atan2(-offX, -offZ)
              await bot.look(snapYaw, 0, true)
              bot.setControlState('forward', true)
              await sleep(Math.min(200, distToCenter * 300))
              bot.setControlState('forward', false)
              await sleep(50)
            }
          }

          const standBlock = bot.blockAt(new Vec3(bx, footY - 1, bz))
          if (standBlock && standBlock.boundingBox === 'block') {
            // Jump, wait for peak, place block below
            bot.setControlState('jump', true)
            await sleep(250) // near peak of jump
            try {
              // Use a race with short timeout so we never hang 5s
              await Promise.race([
                bot.placeBlock(standBlock, new Vec3(0, 1, 0)),
                sleep(800)
              ])
            } catch (_) {}
            bot.setControlState('jump', false)
            await sleep(200)
          } else {
            // No block below — fall back to wall staircase
            if (wallDir) {
              try { await equipBestPickaxe(bot) } catch (_) {}
              const wx = bx + wallDir[0]
              const wz = bz + wallDir[1]
              await this._digSolid(wx, footY + 1, wz)
              await this._digSolid(wx, footY + 2, wz)
              const yaw = Math.atan2(-wallDir[0], -wallDir[1])
              await bot.look(yaw, 0, true)
              bot.setControlState('jump', true)
              bot.setControlState('forward', true)
              await sleep(400)
              bot.setControlState('forward', false)
              bot.setControlState('jump', false)
              await sleep(150)
            }
          }
        } else if (wallDir) {
          // No scaffold — dig staircase into nearest wall
          try { await equipBestPickaxe(bot) } catch (_) {}
          const wx = bx + wallDir[0]
          const wz = bz + wallDir[1]
          await this._digSolid(wx, footY + 1, wz)
          await this._digSolid(wx, footY + 2, wz)
          const yaw = Math.atan2(-wallDir[0], -wallDir[1])
          await bot.look(yaw, 0, true)
          bot.setControlState('jump', true)
          bot.setControlState('forward', true)
          await sleep(400)
          bot.setControlState('forward', false)
          bot.setControlState('jump', false)
          await sleep(150)
        } else {
          // No scaffold, no wall — sprint toward chest to find a wall
          const yaw = Math.atan2(-(nx - bx), -(nz - bz))
          await bot.look(yaw, 0, true)
          bot.setControlState('forward', true)
          bot.setControlState('sprint', true)
          await sleep(300)
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
          await sleep(100)
        }
      }

      if (step % 10 === 0) {
        const newPos = bot.entity?.position
        this._log(`_digToSurface: step ${step} y=${newPos?.y?.toFixed(1) || '?'} target=${targetY}`)
      }
    }

    this._log('_digToSurface: exhausted max steps')
  }

  /**
   * Find a nearby wall (solid block) in a cardinal direction to dig a staircase into.
   * @returns {[number, number]|null} [dx, dz] direction, or null
   * @private
   */
  _findNearbyWall (bx, footY, bz) {
    const bot = this._bot
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    // Prefer direction toward chest
    const chestPos = this._config.getChestPos()
    if (chestPos) {
      dirs.sort((a, b) => {
        const distA = Math.abs((bx + a[0]) - chestPos.x) + Math.abs((bz + a[1]) - chestPos.z)
        const distB = Math.abs((bx + b[0]) - chestPos.x) + Math.abs((bz + b[1]) - chestPos.z)
        return distA - distB
      })
    }
    for (const [dx, dz] of dirs) {
      // Check if there's a solid block at foot+1 level in this direction (a wall to dig into)
      const wallBlock = bot.blockAt(new Vec3(bx + dx, footY + 1, bz + dz))
      if (wallBlock && wallBlock.boundingBox === 'block' && wallBlock.name !== 'bedrock') {
        return [dx, dz]
      }
    }
    return null
  }

  /**
   * Find a placeable scaffold block in inventory (cobblestone, dirt, stone, etc.)
   * @returns {import('prismarine-item').Item|null}
   * @private
   */
  _findScaffoldBlock () {
    const SCAFFOLD_RE = /^(cobblestone|cobbled_deepslate|stone|dirt|coarse_dirt|netherrack|diorite|andesite|granite|tuff|calcite|deepslate|sandstone|red_sandstone|basalt|blackstone|end_stone|mossy_cobblestone|smooth_basalt)$/
    const items = this._bot.inventory.items()
    return items.find(i => SCAFFOLD_RE.test(i.name)) || null
  }

  /**
   * Dig a block if it's solid (not air/water/lava/bedrock)
   * @private
   */
  async _digSolid (x, y, z) {
    const bot = this._bot
    try {
      const block = bot.blockAt(new Vec3(x, y, z))
      if (!block || block.name === 'air' || block.name === 'cave_air' ||
          block.name === 'water' || block.name === 'lava' ||
          block.name === 'bedrock') return
      await bot.dig(block, true)
    } catch (_) {}
  }

  /**
   * Resume previous job after round-trip
   * Called by ResourceSystem after successful return
   */
  resumePreviousJob () {
    if (!this._interruptedJob) {
      this._log('No previous job to resume')
      return
    }

    this._log(`Resuming job: ${this._interruptedJob.type}`)
    this._bus.emit('JOB_RESUME', this._interruptedJob)
    this._interruptedJob = null
  }

  /**
   * Check if we need to return home
   * Called periodically by gathering jobs
   * @returns {{needed: boolean, reason: string|null}}
   */
  checkNeedForReturn () {
    if (!this._config.isConfigured()) {
      return { needed: false, reason: null } // Can't return if no base
    }

    // Check inventory full
    const inventory = this._bot.inventory
    const usedSlots = inventory.slots.filter(s => s).length
    if (usedSlots >= 33) { // 36 total, leave 3 buffer
      return { needed: true, reason: 'inventory_full' }
    }

    // Check tools broken/missing
    const items = inventory.items()
    const hasPickaxe = items.some(i => i.name.includes('pickaxe'))
    const hasAxe = items.some(i => i.name.includes('axe'))

    if (!hasPickaxe) {
      return { needed: true, reason: 'no_pickaxe' }
    }

    // Both good
    return { needed: false, reason: null }
  }

  /**
   * Cleanup method for proper event unsubscription
   */
  _onWatchdogDeadlock () {
    if (!this._isRunning && !this._navigating) return
    this._log('watchdog deadlock — graceful exit')
    this._navigating = false
    this._isRunning = false
    this._pendingHomeReturn = false
    try { this._bot.clearControlStates?.() } catch (_) {}
    this._bus.emit(NavEvents.STOP, { reason: 'watchdog_deadlock' })
  }

  destroy () {
    this._bus.off(CoreEvents.STATE_CHANGED, this._onStateChanged)
    this._bus.off(ResourceEvents.GATHER_START, this._onGatherStart)
    this._bus.off(WatchdogEvents.DEADLOCK_DETECTED, this._onWatchdogDeadlock)
    this._log('Destroyed')
  }

  /** @private */
  _log (msg) {
    console.log(`[HomeBaseSystem] ${msg}`)
  }
}

module.exports = { HomeBaseSystem }
