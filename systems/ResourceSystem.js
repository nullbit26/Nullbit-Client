'use strict'

const { CoreEvents, CombatEvents, ResourceEvents, NavEvents, MovementEvents, WatchdogEvents } = require('../core/EventRegistry')
const { CoreStates } = require('../core/StateManager')
const { isCombatSessionActive } = require('../attackEntity')
const { equipBestAxe, equipBestPickaxe, findBestAxe, findBestShovel } = require('../utils/equipBestTool')
const { Vec3 } = require('vec3')
const { getFreeSlots } = require('../utils/inventoryValue')
const { TreeJob, LOG_NAME_RE, _bk } = require('./TreeJob')
const { OreJob } = require('./OreJob')
const { CaveExplorerJob } = require('./CaveExplorerJob')
const { loadVisitedCaves, saveVisitedCaves } = require('../utils/CavePersistence')
const { dropJunk, shouldDropJunk } = require('../utils/InventoryManager')
const { BranchMineJob } = require('./BranchMineJob')
const { HomeBaseConfig } = require('./HomeBaseConfig')
const { HomeBaseSystem } = require('./HomeBaseSystem')
const { StorageSystem } = require('./StorageSystem')
const { CraftingSystem } = require('./CraftingSystem')

/**
 * Resource type definitions.
 * Each entry maps a resource name to:
 *   - blockMatcher: RegExp matching block names to mine
 *   - jobType: 'tree' | 'ore'
 *   - displayName: human-readable label
 */
const RESOURCE_CONFIG = Object.freeze({
  wood:    { blockMatcher: /(_log|_stem|_hyphae|_wood)$/,         jobType: 'tree', displayName: 'wood',     dropMatcher: /(_log|_stem|_wood)$/ },
  coal:    { blockMatcher: /^(coal_ore|deepslate_coal_ore)$/,     jobType: 'ore',  displayName: 'coal',     dropMatcher: /^coal$/ },
  iron:    { blockMatcher: /^(iron_ore|deepslate_iron_ore)$/,     jobType: 'ore',  displayName: 'iron',     dropMatcher: /^raw_iron$/ },
  gold:    { blockMatcher: /^(gold_ore|deepslate_gold_ore|nether_gold_ore)$/, jobType: 'ore', displayName: 'gold',     dropMatcher: /^(raw_gold|gold_nugget)$/ },
  diamond: { blockMatcher: /^(diamond_ore|deepslate_diamond_ore)$/, jobType: 'ore', displayName: 'diamond', dropMatcher: /^diamond$/ },
  copper:  { blockMatcher: /^(copper_ore|deepslate_copper_ore)$/, jobType: 'ore',  displayName: 'copper',   dropMatcher: /^raw_copper$/ },
  emerald: { blockMatcher: /^(emerald_ore|deepslate_emerald_ore)$/, jobType: 'ore', displayName: 'emerald', dropMatcher: /^emerald$/ },
  lapis:   { blockMatcher: /^(lapis_ore|deepslate_lapis_ore)$/,   jobType: 'ore',  displayName: 'lapis',    dropMatcher: /^lapis_lazuli$/ },
  redstone:{ blockMatcher: /^(redstone_ore|deepslate_redstone_ore)$/, jobType: 'ore', displayName: 'redstone', dropMatcher: /^redstone$/ }
})

const TASK_RESOURCE = 'resource_system_tick'
const TICK_INTERVAL = 10 // ~0.5 s at 20 TPS
const SCAN_RADIUS = 32
const FAILED_BLOCK_TTL_MS = 5 * 60 * 1000
/** How many job failures before a tree is skipped entirely this session */
const TREE_PENALTY_LIMIT = 2

/** Internal gather phase (coarse — TreeJob owns fine-grained state). */
const GATHER_PHASE = Object.freeze({
  IDLE: 'IDLE',
  WORKING: 'WORKING',
  COLLECTING: 'COLLECTING'
})

/** @param {number} ms */
function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * ResourceSystem v3 — lifecycle shell that drives TreeJob FSM instances.
 *
 * Responsibilities (only):
 *   - Start/stop/pause gather lifecycle + event wiring
 *   - Select which tree to lock next (cluster scoring)
 *   - Shared failed-block registry with TTL eviction
 *   - Combat interrupt
 *   - Progress tracking in taskState
 *
 * All felling logic (spot selection, nav, dig, leaf-clear, collect) lives in TreeJob.
 *
 * @typedef {Object} ResourceSystemCtx
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/BotBrain').BotBrain} brain
 * @property {any} config
 * @property {any} [movementActions]
 */

class ResourceSystem {
  /**
   * @param {ResourceSystemCtx} ctx
   */
  constructor (ctx) {
    if (!ctx?.brain) throw new Error('[ResourceSystem] brain is required')
    this._bot = ctx.bot
    this._brain = ctx.brain
    this._bus = ctx.brain.eventBus
    this._config = ctx.config
    this._movement = ctx.movementActions || null

    this._active = false
    this._paused = false
    this._phase = GATHER_PHASE.IDLE
    this._resourceType = null
    /** @type {Map<string, number>} blockKey → failedAt timestamp - global from Brain */
    this._failedBlocks = ctx.brain.globalFailedBlocks
    /** @type {Map<string, number>} treeKey → consecutive fail count */
    this._treePenalty = new Map()
    /** Session telemetry */
    this._session = { startMs: 0, treesComplete: 0, treesFailed: 0, blocksCollected: 0 }
    this._loopToken = 0
    this._wired = false
    /** @type {Map<string, number>} cave key → visitedAt timestamp (TTL-evicted) */
    this._visitedCaves = new Map()
    /** Persist cave visits across restarts */
    this._cavePersistPath = './config/caves.json'
    this._caveVisitedTtlMs = 25 * 60 * 1000

    // Command system
    this._pendingReturnToBase = false

    // Home Base System (autonomous return for inventory/tools)
    this._homeBaseConfig = new HomeBaseConfig()
    this._homeBaseConfig.loadFromConfig('./config/homebase.json')
    this._storageSystem = new StorageSystem(this._bot, this._homeBaseConfig, this._brain)
    this._craftingSystem = new CraftingSystem(this._bot, this._homeBaseConfig, this._brain)
    this._homeBaseSystem = new HomeBaseSystem(
      this._bot,
      this._homeBaseConfig,
      this._storageSystem,
      this._craftingSystem,
      this._brain,
      this._bus
    )
    this._homeBaseRunning = false

    // Overrides for tests
    this._navPollMs = ctx.config?.resourceNavPollMs ?? 200
    this._dropsWaitMs = ctx.config?.resourceDropsWaitMs ?? 500
    this._digSettleMs = ctx.config?.resourceDigSettleMs ?? 250

    // Load persisted cave visits from previous session
    try {
      const loaded = loadVisitedCaves(this._visitedCaves, this._caveVisitedTtlMs, this._cavePersistPath)
      if (loaded > 0) {
        try { this._brain.log.info(`[ResourceSystem] loaded ${loaded} visited caves from disk`) } catch (_) {}
      }
    } catch (_) {}

    this._lastTelemetryEmit = 0

    this._onGatherStart = this._onGatherStart.bind(this)
    this._onGatherStop = this._onGatherStop.bind(this)
    this._tick = this._tick.bind(this)
    this._onStateChanged = this._onStateChanged.bind(this)
    this._onWatchdogDeadlock = this._onWatchdogDeadlock.bind(this)
  }

  /** @returns {boolean} */
  isGathering () { return this._active }

  /** @returns {keyof typeof GATHER_PHASE} */
  getPhase () { return this._phase }

  /**
   * Begin gathering a resource type.
   * Supported: 'wood', 'coal', 'iron', 'gold', 'diamond', 'copper', 'emerald', 'lapis', 'redstone'.
   * @param {string} [resourceType]
   */
  startGather (resourceType, targetAmount = 0) {
    const type = String(resourceType || 'wood')
    if (this._active) this.stopGather('RESTART')

    this._active = true
    this._resourceType = type
    this._targetAmount = Math.max(0, Number(targetAmount) || 0)
    this._homeTrips = 0
    this._phase = GATHER_PHASE.IDLE
    // Don't clear failedBlocks - preserve global blacklist between job restarts (5 min TTL)
    this._treePenalty.clear()
    this._session = { startMs: Date.now(), treesComplete: 0, treesFailed: 0, blocksCollected: 0 }
    if (this._targetAmount > 0) try { this._brain.log.info(`[ResourceSystem] target: ${this._targetAmount}x ${type}`) } catch (_) {}

    this._bus.emit(MovementEvents.SET_IDLE, { at: Date.now() })
    this._bus.emit(NavEvents.STOP, { reason: 'gather_start', at: Date.now() })

    if (this._brain.taskState) {
      this._brain.taskState.setCurrentTask({ kind: 'gather', resource: type })
    }

    try { this._brain.log.info('[ResourceSystem] start gather:', type) } catch (_) {}
    this._loopToken++
    this._loop(this._loopToken)
  }

  /**
   * Permanently stop gathering. Clears currentTask.
   * @param {string} [reason]
   */
  stopGather (reason) {
    if (!this._active) return
    this._active = false
    this._phase = GATHER_PHASE.IDLE

    if (this._brain.taskState) {
      this._brain.taskState.clearCurrentTask()
      this._brain.taskState.clearInterruptedTask?.()
    }
    this._bus.emit(NavEvents.STOP, { reason: 'gather_stop', at: Date.now() })

    const elapsed = Date.now() - (this._session.startMs || Date.now())
    try {
      this._brain.log.info(
        `[ResourceSystem] stop gather: ${reason}` +
        ` | durationMs=${elapsed}` +
        ` treesComplete=${this._session.treesComplete}` +
        ` treesFailed=${this._session.treesFailed}` +
        ` blocksCollected=${this._session.blocksCollected}`
      )
    } catch (_) {}
  }

  /**
   * Pause on combat threat. Moves task → interruptedTask, enters RecoveryHold.
   * @param {string} [reason]
   */
  pauseGather (reason) {
    if (!this._active) return
    this._active = false
    this._phase = GATHER_PHASE.IDLE

    if (this._brain.taskState) {
      this._brain.taskState.interruptCurrentTask(String(reason || 'UNKNOWN'))
    }
    if (this._brain.recoveryHoldSystem) {
      this._brain.recoveryHoldSystem.enter('GATHER_INTERRUPTED')
    }

    this._bus.emit(NavEvents.STOP, { reason: 'gather_pause', at: Date.now() })
    this._bus.emit(ResourceEvents.GATHER_PAUSED, { reason: String(reason || 'UNKNOWN'), at: Date.now() })

    try { this._brain.log.info('[ResourceSystem] pause gather:', reason) } catch (_) {}
  }

  /** @returns {boolean} */
  _shouldInterrupt () {
    const s = this._brain.state.getState()
    if (s === CoreStates.COMBAT || s === CoreStates.FLEE) return true
    if (isCombatSessionActive()) return true
    return false
  }

  /** @private Check if a block is marked as failed within the timeout window */
  _isFailed (blockKey) {
    const ts = this._failedBlocks.get(blockKey)
    if (!ts) return false
    return Date.now() - ts < FAILED_BLOCK_TTL_MS
  }

  /**
   * Pick the best tree to lock next.
   * Scores clusters by (logCount * 10 - distToBot); returns {tx, tz} or null.
   */
  _selectNextTree () {
    if (!this._bot.findBlocks) {
      // Legacy / test fallback — no cluster scoring, just return a single block's X,Z
      if (!this._bot.findBlock) return null
      const b = this._bot.findBlock({
        matching: (blk) => blk != null && LOG_NAME_RE.test(blk.name),
        maxDistance: SCAN_RADIUS
      })
      if (!b) return null
      if (this._isFailed(_bk(b.position))) return null
      return { tx: b.position.x, tz: b.position.z, seedBlock: b }
    }
    const positions = this._bot.findBlocks({
      matching: (b) => b != null && LOG_NAME_RE.test(b.name),
      maxDistance: SCAN_RADIUS,
      count: 64
    })
    const valid = positions.filter(p => {
      if (this._isFailed(_bk(p))) return false
      const tk = `${p.x},${p.z}`
      if ((this._treePenalty.get(tk) || 0) >= TREE_PENALTY_LIMIT) return false
      return true
    })
    if (valid.length === 0) return null

    const botPos = this._bot.entity?.position
    const clusters = new Map()
    for (const p of valid) {
      const key = `${p.x},${p.z}`
      const e = clusters.get(key)
      if (!e) clusters.set(key, { count: 1, x: p.x, z: p.z, lowestY: p.y, seedPos: p })
      else {
        e.count++
        if (p.y < e.lowestY) { e.lowestY = p.y; e.seedPos = p }
      }
    }

    let best = null; let bestScore = -Infinity
    for (const e of clusters.values()) {
      const dx = botPos ? e.x - botPos.x : 0
      const dz = botPos ? e.z - botPos.z : 0
      const score = e.count * 10 - Math.sqrt(dx * dx + dz * dz)
      if (score > bestScore) { bestScore = score; best = e }
    }
    if (!best) return null
    // Resolve seedBlock — actual Block object for the lowest log position
    const seedBlock = this._bot.blockAt?.(best.seedPos) || null
    // All positions for this cluster sorted lowest-first (fed to TreeJob as initialPositions)
    const allPositions = valid
      .filter(p => p.x === best.x && p.z === best.z)
      .sort((a, b) => a.y - b.y)
    return { tx: best.x, tz: best.z, seedBlock, allPositions }
  }

  /**
   * Pick the nearest ore block matching blockMatcher.
   * Scores by (clusterCount * 8 - dist) to prefer dense veins nearby.
   * @private
   * @param {RegExp} blockMatcher
   * @returns {import('prismarine-block').Block | null}
   */
  _selectNextOre (blockMatcher) {
    const botPos = this._bot.entity?.position

    if (!this._bot.findBlocks) {
      if (!this._bot.findBlock) return null
      const b = this._bot.findBlock({
        matching: (blk) => blk != null && blk.position != null && blockMatcher.test(blk.name),
        maxDistance: SCAN_RADIUS
      })
      if (!b || !b.position || this._isFailed(_bk(b.position))) return null
      const tk = _bk(b.position)
      if ((this._treePenalty.get(tk) || 0) >= TREE_PENALTY_LIMIT) return null
      return b
    }

    const positions = this._bot.findBlocks({
      matching: (blk) => blk != null && blockMatcher.test(blk.name),
      maxDistance: SCAN_RADIUS,
      count: 64
    })
    const valid = positions.filter(p => {
      if (this._isFailed(_bk(p))) return false
      if ((this._treePenalty.get(_bk(p)) || 0) >= TREE_PENALTY_LIMIT) return false
      return true
    })
    if (valid.length === 0) return null

    // Score: prefer clusters (nearby blocks = denser vein) and proximity
    let best = null; let bestScore = -Infinity
    for (const p of valid) {
      const nearby = valid.filter(q =>
        Math.abs(q.x - p.x) <= 2 && Math.abs(q.y - p.y) <= 2 && Math.abs(q.z - p.z) <= 2
      ).length
      const dx = botPos ? p.x - botPos.x : 0
      const dy = botPos ? p.y - botPos.y : 0
      const dz = botPos ? p.z - botPos.z : 0
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const score = nearby * 8 - dist
      if (score > bestScore) { bestScore = score; best = p }
    }
    if (!best) return null
    return this._bot.blockAt?.(best) || null
  }

  /**
   * @private
   * @param {number} token
   */
  async _loop (token) {
    await sleep(0)

    const alive = () => this._active && this._loopToken === token
    if (!alive()) return

    // Equip best tool once at start — race against 3s timeout to avoid hanging on respawn
    const resCfg = RESOURCE_CONFIG[this._resourceType] || RESOURCE_CONFIG.wood
    try {
      const equipPromise = resCfg.jobType === 'ore'
        ? equipBestPickaxe(this._bot)
        : equipBestAxe(this._bot)
      const tool = await Promise.race([
        equipPromise,
        sleep(3000).then(() => null)
      ])
      if (tool) try { this._brain.log.info('[ResourceSystem] equipped', tool) } catch (_) {}
    } catch (e) {
      try { this._brain.log.warn('[ResourceSystem] equip tool failed:', e?.message) } catch (_) {}
    }

    // Check inventory — only go to base if something critical is missing
    if (alive() && this._storageSystem) {
      const { ready, missing } = this._storageSystem.checkInventoryReady()
      if (ready) {
        try { this._brain.log.info('[ResourceSystem] inventory ready — skipping base restock') } catch (_) {}
      } else {
        const missMsg = `Не хватает: ${missing.join(', ')}. Иду на базу за припасами, мяу!`
        try { this._bot.chat(missMsg) } catch (_) {}
        try { await this._brain.voice?.speak(missMsg) } catch (_) {}
        try {
          this._brain.log.info(`[ResourceSystem] inventory missing: ${missing.join(', ')} — restocking`)
          await this._storageSystem.restockForExpedition()
          this._brain.log.info('[ResourceSystem] restock done')
        } catch (e) {
          try { this._brain.log.warn('[ResourceSystem] restock failed:', e?.message) } catch (_) {}
        }
      }
    }
    if (!alive()) return

    while (alive()) {
      if (this._shouldInterrupt()) { this.pauseGather('HOSTILE_CONTACT'); return }

      // Stop if target amount reached
      if (this._targetAmount > 0) {
        const cfg2 = RESOURCE_CONFIG[this._resourceType] || RESOURCE_CONFIG.wood
        const collected = cfg2.dropMatcher
          ? this._bot.inventory.items().filter(i => cfg2.dropMatcher.test(i.name)).reduce((s, i) => s + i.count, 0)
          : 0
        if (collected >= this._targetAmount) {
          try { this._brain.log.info(`[ResourceSystem] target reached: ${collected}/${this._targetAmount} ${this._resourceType} — stopping`) } catch (_) {}
          const doneMsg = `Добыл ${collected} ${this._resourceType}. Возвращаюсь на базу, мяу!`
          try { this._bot.chat(doneMsg) } catch (_) {}
          try { await this._brain.voice?.speak(doneMsg) } catch (_) {}
          if (this._homeBaseSystem) {
            try { await this._climbToSurface() } catch (_) {}
            try { await this._homeBaseSystem.executeRoundTrip({ reason: 'target_reached' }) } catch (_) {}
          }
          const readyMsg = `Я на базе! Готов к работе, мяу!`
          try { this._bot.chat(readyMsg) } catch (_) {}
          try { await this._brain.voice?.speak(readyMsg) } catch (_) {}
          this.stopGather('TARGET_REACHED')
          return
        }
      }

      // Try to drop junk before stopping for full inventory
      if (shouldDropJunk(this._bot, 0.85)) {
        try {
          const freed = await dropJunk(this._bot, { targetFreeSlots: 6, logger: this._brain.log })
          if (freed > 0) try { this._brain.log.info(`[ResourceSystem] dropped ${freed} junk stacks`) } catch (_) {}
        } catch (_) {}
      }
      // Stop gathering if inventory is full (≤2 free slots)
      if (getFreeSlots(this._bot) <= 2) {
        try { this._brain.log.info('[ResourceSystem] inventory full — stopping gather') } catch (_) {}
        this.stopGather('INVENTORY_FULL')
        return
      }

      this._phase = GATHER_PHASE.IDLE

      // Evict stale failed-block entries
      const now = Date.now()
      for (const [key, ts] of this._failedBlocks) {
        if (now - ts > FAILED_BLOCK_TTL_MS) this._failedBlocks.delete(key)
      }

      const cfg = RESOURCE_CONFIG[this._resourceType] || RESOURCE_CONFIG.wood

      const onBlockCollected = () => {
        this._session.blocksCollected++
        const ts = this._brain.taskState
        if (ts?.currentTask) {
          const prev = ts.currentTask.progress || {}
          ts.setCurrentTask({ ...ts.currentTask, progress: { ...prev, blocksCollected: this._session.blocksCollected } })
        }
      }

      let job, targetKey, result

      if (cfg.jobType === 'ore') {
        // ── OreJob path ──
        const seed = this._selectNextOre(cfg.blockMatcher)
        if (!seed) {
          try { this._brain.log.info('[ResourceSystem] no', cfg.displayName, 'ore visible — trying cave exploration') } catch (_) {}
          const caveJob = new CaveExplorerJob(
            {
              bot: this._bot,
              bus: this._bus,
              logger: this._brain.log,
              shouldInterrupt: () => this._shouldInterrupt(),
              navPollMs: this._navPollMs,
              visitedCaves: this._visitedCaves
            },
            alive
          )
          const caveResult = await caveJob.run()
          // Persist updated cave visits immediately after each run
          try { saveVisitedCaves(this._visitedCaves, this._caveVisitedTtlMs, this._cavePersistPath) } catch (_) {}
          if (!alive()) return
          if (caveResult === 'interrupted' || this._shouldInterrupt()) { this.pauseGather('HOSTILE_CONTACT'); return }
          if (caveResult === 'fail') {
            // Dig shaft to optimal Y first, then branch mine at that depth
            try { this._brain.log.info('[ResourceSystem] no cave found — digging shaft then branch mining') } catch (_) {}
            const shaftOk = await this._digShaftDown(cfg.displayName)
            if (!alive()) return
            if (this._shouldInterrupt()) { this.pauseGather('HOSTILE_CONTACT'); return }
            if (!shaftOk) { this.stopGather('NO_BLOCKS'); return }
            // Now at correct Y — run branch mining
            const branchJob = new BranchMineJob(
              {
                bot: this._bot,
                bus: this._bus,
                oreName: cfg.displayName,
                blockMatcher: cfg.blockMatcher,
                dropMatcher: cfg.dropMatcher,
                logger: this._brain.log,
                shouldInterrupt: () => this._shouldInterrupt(),
                navPollMs: this._navPollMs,
                onBlockCollected: onBlockCollected
              },
              alive
            )
            const branchResult = await branchJob.run()
            if (!alive()) return
            if (branchResult === 'interrupted' || this._shouldInterrupt()) { this.pauseGather('HOSTILE_CONTACT'); return }
            // branchResult === 'complete' or 'fail' — either way loop back to re-scan for ore
          }
          // Cave reached — loop back and re-scan for ore from new position
          continue
        }
        targetKey = _bk(seed.position || seed)
        // Skip seed that has failed too recently (ore-level retry throttle)
        if (!this._oreRetry) this._oreRetry = new Map()
        const retryEntry = this._oreRetry.get(targetKey)
        if (retryEntry && retryEntry.count >= 2 && Date.now() - retryEntry.ts < 15_000) {
          // Temporarily ban this seed, skip — _selectNextOre will pick a different one next iteration
          this._failedBlocks.set(targetKey, Date.now())
          await sleep(50)
          continue
        }
        try { await equipBestPickaxe(this._bot) } catch (_) {}
        try { this._brain.log.info('[ResourceSystem] starting OreJob for', cfg.displayName, 'at', targetKey) } catch (_) {}
        this._phase = GATHER_PHASE.WORKING
        job = new OreJob(
          {
            bot: this._bot,
            bus: this._bus,
            blockMatcher: cfg.blockMatcher,
            dropMatcher: cfg.dropMatcher,
            resourceName: cfg.displayName,
            logger: this._brain.log,
            movement: this._movement,
            shouldInterrupt: () => this._shouldInterrupt(),
            onBlockCollected,
            navPollMs: this._navPollMs,
            dropsWaitMs: this._dropsWaitMs,
            digSettleMs: this._digSettleMs,
            homeBaseSystem: this._homeBaseSystem,
            pendingReturnToBase: () => this._pendingReturnToBase
          },
          seed.position || seed,
          this._failedBlocks,
          alive
        )
      } else {
        // ── TreeJob path (wood) ──
        const lock = this._selectNextTree()
        if (!lock) {
          try { this._brain.log.info('[ResourceSystem] no logs within', SCAN_RADIUS, 'blocks') } catch (_) {}
          this.stopGather('NO_BLOCKS')
          return
        }
        targetKey = `${lock.tx},${lock.tz}`
        try { await equipBestAxe(this._bot) } catch (_) {}
        try { this._brain.log.info('[ResourceSystem] starting TreeJob for', lock) } catch (_) {}
        this._phase = GATHER_PHASE.WORKING
        job = new TreeJob(
          {
            bot: this._bot,
            bus: this._bus,
            logger: this._brain.log,
            movement: this._movement,
            shouldInterrupt: () => this._shouldInterrupt(),
            onBlockCollected,
            initialLog: lock.seedBlock || null,
            initialPositions: lock.allPositions || null,
            navPollMs: this._navPollMs,
            dropsWaitMs: this._dropsWaitMs,
            digSettleMs: this._digSettleMs,
            homeBaseSystem: this._homeBaseSystem
          },
          lock,
          this._failedBlocks,
          alive
        )
      }

      result = await job.run()
      if (!alive()) return

      // Check target immediately after any job finishes (even 'fail'/'complete')
      if (this._targetAmount > 0) {
        const cfgChk = RESOURCE_CONFIG[this._resourceType] || RESOURCE_CONFIG.wood
        const collectedNow = cfgChk.dropMatcher
          ? this._bot.inventory.items().filter(i => cfgChk.dropMatcher.test(i.name)).reduce((s, i) => s + i.count, 0)
          : 0
        try { this._brain.log.info(`[ResourceSystem] post-job inventory check: ${collectedNow}/${this._targetAmount} ${this._resourceType}`) } catch (_) {}
        if (collectedNow >= this._targetAmount) {
          try { this._brain.log.info(`[ResourceSystem] target reached after job: ${collectedNow}/${this._targetAmount} — going home`) } catch (_) {}
          const doneMsg = `Добыл ${collectedNow} ${this._resourceType}. Возвращаюсь на базу, мяу!`
          try { this._bot.chat(doneMsg) } catch (_) {}
          try { await this._brain.voice?.speak(doneMsg) } catch (_) {}
          if (this._homeBaseSystem) {
            try { await this._climbToSurface() } catch (_) {}
            try { await this._homeBaseSystem.executeRoundTrip({ reason: 'target_reached' }) } catch (_) {}
          }
          const readyMsg = `Я на базе! Готов к работе, мяу!`
          try { this._bot.chat(readyMsg) } catch (_) {}
          try { await this._brain.voice?.speak(readyMsg) } catch (_) {}
          this.stopGather('TARGET_REACHED')
          return
        }
      }

      if (result === 'interrupted' || this._shouldInterrupt()) {
        // If an OreJob was interrupted without digging anything, penalise the seed
        // so we don't immediately re-tunnel the same ore after combat resumes.
        if (cfg.jobType === 'ore' && job?._tel?.oreDigged === 0 && job?._tel?.tunnelAttempts > 0) {
          if (!this._oreRetry) this._oreRetry = new Map()
          const prev = this._oreRetry.get(targetKey)
          this._oreRetry.set(targetKey, { count: (prev?.count || 0) + 1, ts: Date.now() })
          try { this._brain.log.info('[ResourceSystem] interrupted tunnel with 0 ore — penalising seed', targetKey) } catch (_) {}
        }
        this.pauseGather('HOSTILE_CONTACT')
        return
      }

      try { this._brain.log.info('[ResourceSystem] job result:', result) } catch (_) {}

      if (result === 'paused_for_home') {
        this._homeTrips = (this._homeTrips || 0) + 1
        try { this._brain.log.info(`[ResourceSystem] paused_for_home — trip #${this._homeTrips}`) } catch (_) {}
        if (this._homeTrips > 3) {
          if (this._resourceType !== 'wood') {
            try { this._brain.log.warn('[ResourceSystem] 3 home trips without pickaxe — switching to wood to get crafting materials') } catch (_) {}
            try { this._bot.chat('Нет кирки и материалов — пойду срублю дерево для инструментов, мяу!') } catch (_) {}
            this._resourceType = 'wood'
            this._targetAmount = 4
            this._homeTrips = 0
            continue
          }
          try { this._brain.log.warn('[ResourceSystem] 3 home trips without pickaxe — stopping gather (no materials?)') } catch (_) {}
          this.stopGather('NO_TOOL_AFTER_HOME')
          return
        }
        if (this._homeBaseSystem) {
          try { await this._climbToSurface() } catch (_) {}
          try { await this._homeBaseSystem.executeRoundTrip({ reason: 'no_pickaxe', previousJob: null }) } catch (_) {}
        }
        // Hard guard: never spin faster than once per 2s regardless of outcome
        await sleep(2000)
        // Reset counter on successful tool acquisition
        const hasPick = this._bot.inventory.items().some(i => i.name.includes('_pickaxe'))
        if (hasPick) this._homeTrips = 0
        // After returning home, loop continues to pick next ore
        continue
      }

      if (result === 'fail') {
        this._session.treesFailed++
        if (cfg.jobType === 'ore') {
          // Track ore-seed retries — after 2 quick fails, temporarily ban seed
          if (!this._oreRetry) this._oreRetry = new Map()
          const prev = this._oreRetry.get(targetKey)
          this._oreRetry.set(targetKey, { count: (prev?.count || 0) + 1, ts: Date.now() })
        } else {
          // Ore jobs manage their own internal failed-block registry — don't double-ban
          this._failedBlocks.set(targetKey, Date.now())
          this._treePenalty.set(targetKey, (this._treePenalty.get(targetKey) || 0) + 1)
          try { this._brain.log.warn('[ResourceSystem] penalty', targetKey, '=', this._treePenalty.get(targetKey)) } catch (_) {}
        }
      } else if (result === 'complete') {
        this._session.treesComplete++
        if (cfg.jobType === 'ore') {
          if (this._oreRetry) this._oreRetry.delete(targetKey)
        } else {
          this._treePenalty.delete(targetKey)
        }
      }
      // Loop continues — pick next target
    }
  }

  _onGatherStart(payload) {
    const resource = payload && payload.resource ? payload.resource : 'wood';
    const amount = payload && payload.amount ? Number(payload.amount) : 0;
    this.startGather(resource, amount);
  }

  _onGatherStop() {
    this.stopGather('USER_COMMAND');
  }

  /**
   * Dig a shaft down to optimal Y level for the ore type.
   * Deep ores (targetY < 0) → vertical shaft (fast).
   * Shallow ores (targetY ≥ 0) → staircase (safe, no fall risk).
   * Returns true if reached target depth, false if interrupted or danger.
   */
  async _digShaftDown (oreName) {
    const bot = this._bot
    const TARGET_Y = { diamond: -58, iron: 16, coal: 96, gold: -16, copper: 48, lapis: 0, redstone: -58, emerald: 232 }
    const targetY = TARGET_Y[oreName] ?? 16
    const curY = Math.floor(bot.entity?.position?.y ?? 64)
    if (curY <= targetY + 3) return true

    // Deep ores (below sea level) — dig straight down, much faster
    if (targetY < 0) {
      return await this._digShaftDownVertical(targetY, oreName)
    }

    try { this._brain.log.info(`[ResourceSystem] digging staircase from Y=${curY} to Y=${targetY} for ${oreName}`) } catch (_) {}
    try { this._bot.chat(`Копаю лестничную шахту до Y=${targetY}...`) } catch (_) {}

    const DANGER = /^(lava|flowing_lava|water|flowing_water)$/

    // Pick a cardinal direction based on bot yaw
    const yaw = bot.entity?.yaw ?? 0
    let dirX = Math.round(-Math.sin(yaw))
    let dirZ = Math.round(Math.cos(yaw))
    // Ensure non-zero direction
    if (dirX === 0 && dirZ === 0) { dirX = 1; dirZ = 0 }

    let rotations = 0
    let lastStuckPos = null
    let stuckCount = 0
    let totalUnstucks = 0
    const MAX_TOTAL_UNSTUCKS = 8

    const _digSafe = async (blk) => {
      if (!blk || blk.boundingBox !== 'block' || DANGER.test(blk.name)) return
      // deepslate and ancient_debris need more time — use 8s timeout
      const isHard = /deepslate|obsidian|ancient_debris/.test(blk.name)
      try { await Promise.race([bot.dig(blk, true), sleep(isHard ? 8000 : 4000)]) } catch (_) {}
    }

    // Walk + dig N blocks sideways in current dirX/dirZ
    const _sidestep = async (steps = 2) => {
      for (let i = 0; i < steps; i++) {
        const sp = bot.entity?.position
        if (!sp) break
        const sx = Math.floor(sp.x), sy = Math.floor(sp.y), sz = Math.floor(sp.z)
        try { await equipBestPickaxe(bot) } catch (_) {}
        for (const dy of [1, 0]) await _digSafe(bot.blockAt?.(new Vec3(sx + dirX, sy + dy, sz + dirZ)))
        try { await bot.look(Math.atan2(-dirX, -dirZ), 0, true) } catch (_) {}
        bot.setControlState('forward', true)
        await sleep(400)
        bot.setControlState('forward', false)
        await sleep(100)
      }
    }

    // Rotate 90° CW and sidestep; returns false if rotated too many times
    const _rotateSidestep = async (reason) => {
      if (rotations >= 4) {
        try { this._brain.log.info(`[ResourceSystem] staircase: ${reason} — all directions blocked, stopping`) } catch (_) {}
        return false
      }
      try { this._brain.log.info(`[ResourceSystem] staircase: ${reason} — sidestepping`) } catch (_) {}
      ;[dirX, dirZ] = [dirZ, -dirX]
      rotations++
      await _sidestep(2)
      return true
    }

    const MAX_STEPS = (curY - targetY) * 4
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this._shouldInterrupt()) return false
      const pos = bot.entity?.position
      if (!pos) return false
      const footY = Math.floor(pos.y)
      if (footY <= targetY + 1) break

      const bx = Math.floor(pos.x)
      const bz = Math.floor(pos.z)

      // Anti-stuck: same position 3 steps in a row → clear all neighbors + jump + rotate
      const posKey = `${bx},${footY},${bz}`
      if (posKey === lastStuckPos) {
        if (++stuckCount >= 3) {
          totalUnstucks++
          if (totalUnstucks > MAX_TOTAL_UNSTUCKS) {
            try { this._brain.log.info(`[ResourceSystem] staircase: too many unstucks (${totalUnstucks}) — giving up at Y=${footY}`) } catch (_) {}
            return true
          }
          try { this._brain.log.info(`[ResourceSystem] staircase: stuck at ${posKey} (${totalUnstucks}/${MAX_TOTAL_UNSTUCKS}) — forcing unstick`) } catch (_) {}
          for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]])
            for (const dy of [0, 1, -1])
              await _digSafe(bot.blockAt?.(new Vec3(bx + dx, footY + dy, bz + dz)))
          bot.setControlState('jump', true); await sleep(300); bot.setControlState('jump', false)
          ;[dirX, dirZ] = [dirZ, -dirX]
          try { await bot.look(Math.atan2(-dirX, -dirZ), 0, true) } catch (_) {}
          bot.setControlState('forward', true); await sleep(500); bot.setControlState('forward', false)
          stuckCount = 0; lastStuckPos = null
          continue
        }
      } else { lastStuckPos = posKey; stuckCount = 0 }

      const stepFloorX = bx + dirX
      const stepFloorZ = bz + dirZ
      const stepFloorY = footY - 1

      // Safety 1: lava/water directly in path
      let dangerAhead = false
      for (let look = 0; look <= 2; look++) {
        const b = bot.blockAt?.(new Vec3(bx + dirX * look, footY - look, bz + dirZ * look))
        if (b && DANGER.test(b.name)) { dangerAhead = true; break }
      }
      if (dangerAhead) { if (!await _rotateSidestep('lava/water ahead')) return true; continue }

      // Safety 2: void ≥10 blocks deep ahead
      let airBelow = 0
      for (let dy = 1; dy <= 12; dy++) {
        const b = bot.blockAt?.(new Vec3(stepFloorX, stepFloorY - dy, stepFloorZ))
        if (!b || b.boundingBox === 'empty') airBelow++; else break
      }
      if (airBelow >= 10) { if (!await _rotateSidestep(`void ${airBelow} blocks`)) return true; continue }
      rotations = 0

      // Safety 3: lava/water pool below step (skip if already in water)
      const feetBlk = bot.blockAt?.(new Vec3(bx, footY, bz))
      if (!feetBlk || !/^(water|flowing_water)$/.test(feetBlk.name)) {
        let poolDanger = false
        for (let dy = 1; dy <= 4; dy++) {
          const b = bot.blockAt?.(new Vec3(stepFloorX, stepFloorY - dy, stepFloorZ))
          if (b && DANGER.test(b.name)) { poolDanger = true; break }
        }
        if (poolDanger) { if (!await _rotateSidestep('danger pool below')) return true; continue }
      }

      // Dig 1×2 staircase + step down
      try { await equipBestPickaxe(bot) } catch (_) {}
      for (const vec of [
        new Vec3(bx + dirX, footY + 1, bz + dirZ), // head
        new Vec3(bx + dirX, footY,     bz + dirZ), // foot
        new Vec3(bx + dirX, footY - 1, bz + dirZ), // step down
      ]) await _digSafe(bot.blockAt?.(vec))

      try { await bot.look(Math.atan2(-dirX, -dirZ), 0.3, true) } catch (_) {}
      bot.setControlState('forward', true)
      await sleep(400)
      bot.setControlState('forward', false)
      await sleep(100)
    }

    try { this._brain.log.info(`[ResourceSystem] staircase complete at Y=${Math.floor(bot.entity?.position?.y ?? 0)}`) } catch (_) {}
    return true
  }

  /**
   * Dig a 1×2 vertical shaft straight down to targetY.
   * Checks for void (≥6 air below) and lava before each step.
   * Falls with jump=false, lands safely.
   * Returns true if reached targetY, false on danger/interrupt.
   */
  async _digShaftDownVertical (targetY, oreName) {
    const bot = this._bot
    const DANGER = /^(lava|flowing_lava|water|flowing_water)$/
    const sleep = ms => new Promise(r => setTimeout(r, ms))

    const curY = Math.floor(bot.entity?.position?.y ?? 64)
    try { this._brain.log.info(`[ResourceSystem] vertical shaft: Y=${curY} → Y=${targetY} for ${oreName}`) } catch (_) {}
    try { this._bot.chat(`Копаю вертикальную шахту до Y=${targetY}...`) } catch (_) {}

    let lastY = curY
    let stuckCount = 0

    while (!this._shouldInterrupt()) {
      const pos = bot.entity?.position
      if (!pos) break
      const footY = Math.floor(pos.y)
      if (footY <= targetY + 1) break

      const bx = Math.floor(pos.x)
      const bz = Math.floor(pos.z)

      // Anti-stuck: if Y hasn't changed 4 iters in a row
      if (footY === lastY) {
        stuckCount++
        if (stuckCount > 4) {
          try { this._brain.log.info(`[ResourceSystem] vertical shaft: stuck at Y=${footY} — aborting`) } catch (_) {}
          break
        }
      } else {
        lastY = footY
        stuckCount = 0
      }

      // Safety: scan 6 blocks below for void or lava before digging
      let airBelow = 0
      let dangerBelow = false
      for (let dy = 1; dy <= 8; dy++) {
        const b = bot.blockAt?.(new Vec3(bx, footY - dy, bz))
        if (!b || b.boundingBox === 'empty' || b.name === 'air') {
          airBelow++
        } else if (DANGER.test(b.name)) {
          dangerBelow = true
          break
        } else {
          break
        }
      }

      if (dangerBelow) {
        try { this._brain.log.info(`[ResourceSystem] vertical shaft: lava below at Y=${footY} — stopping`) } catch (_) {}
        try { this._bot.chat(`Лава под ногами на Y=${footY}! Останавливаю шахту.`) } catch (_) {}
        break
      }

      if (airBelow >= 6) {
        try { this._brain.log.info(`[ResourceSystem] vertical shaft: void ${airBelow} blocks below — stopping`) } catch (_) {}
        try { this._bot.chat(`Пустота под ногами на Y=${footY}! Останавливаю шахту.`) } catch (_) {}
        break
      }

      try { await equipBestPickaxe(bot) } catch (_) {}

      // Dig foot block and block below foot (1×2 column downward)
      await bot.look(0, Math.PI / 2, true) // look straight down
      for (const dy of [0, -1]) {
        const blk = bot.blockAt?.(new Vec3(bx, footY + dy, bz))
        if (blk && blk.boundingBox === 'block' && !DANGER.test(blk.name)) {
          const isHard = /deepslate|obsidian|ancient_debris/.test(blk.name)
          try {
            await Promise.race([
              bot.dig(blk, true),
              sleep(isHard ? 10_000 : 4_000)
            ])
          } catch (_) {}
        }
      }

      // Drop down into dug space — just stop holding jump, gravity does the work
      await sleep(400)
    }

    const finalY = Math.floor(bot.entity?.position?.y ?? 0)
    try { this._brain.log.info(`[ResourceSystem] vertical shaft done at Y=${finalY}`) } catch (_) {}
    return finalY <= targetY + 3
  }

  /**
   * If bot is underground (below Y=0), dig straight up to the surface.
   * Much faster than staircase. Above Y=0 — pathfinder handles it normally.
   */
  async _climbToSurface () {
    const DEEP_Y = 0
    const bot = this._bot
    const curY = Math.floor(bot.entity?.position?.y ?? 64)
    if (curY > DEEP_Y) return // shallow — pathfinder will handle it

    try { this._brain.log.info(`[ResourceSystem] deep mine (Y=${curY}) — digging straight up to Y=${DEEP_Y}`) } catch (_) {}
    try { this._bot.chat(`Копаю вертикальный выход с Y=${curY}...`) } catch (_) {}

    const DANGER = /^(lava|flowing_lava|water|flowing_water)$/
    const sleep = ms => new Promise(r => setTimeout(r, ms))

    // Equip best available digging tool — pickaxe first, axe, then shovel
    // NOTE: stone pickaxe requires 3×3 crafting table — cannot craft in-inventory
    const _equipBestDigger = async () => {
      // 1. Pickaxe
      const pick = await equipBestPickaxe(bot).catch(() => null)
      if (pick) return pick

      // 2. Кирка сломалась — объявляем
      try { this._brain.log.info(`[ResourceSystem] climb: pickaxe broken mid-shaft!`) } catch (_) {}
      try { this._bot.chat(`Сломал кирку в шахте на Y=${Math.floor(bot.entity?.position?.y ?? 0)}! Пытаюсь скрафтить новую...`) } catch (_) {}
      try { await this._brain.voice?.speak(`Сломал кирку в шахте! Крафчу новую!`) } catch (_) {}

      // 2a. Попробовать скрафтить кирку через верстак в инвентаре
      {
        const inv = bot.inventory.items()
        const hasTable   = inv.some(i => i.name === 'crafting_table')
        const cobble     = inv.find(i => /cobblestone|cobbled_deepslate/.test(i.name) && i.count >= 3)
        const sticks     = inv.find(i => i.name === 'stick' && i.count >= 2)
        if (hasTable && cobble && sticks) {
          try {
            const pos2 = bot.entity?.position
            if (pos2) {
              const tableVec = new Vec3(Math.floor(pos2.x), Math.floor(pos2.y) - 1, Math.floor(pos2.z))
              const tableItem = inv.find(i => i.name === 'crafting_table')
              await bot.equip(tableItem, 'hand')
              const floorBlk = bot.blockAt?.(tableVec)
              if (floorBlk && floorBlk.boundingBox === 'block') {
                await bot.placeBlock(floorBlk, new Vec3(0, 1, 0))
                await sleep(300)
                const tableBlk = bot.blockAt?.(new Vec3(tableVec.x, tableVec.y + 1, tableVec.z))
                if (tableBlk && tableBlk.name === 'crafting_table') {
                  const pickId = bot.registry.itemsByName['stone_pickaxe']?.id
                  if (pickId) {
                    const recipe = bot.recipesFor(pickId, null, 1, tableBlk)[0]
                    if (recipe) {
                      await bot.craft(recipe, 1, tableBlk)
                      this._brain.log.info(`[ResourceSystem] climb: crafted stone pickaxe at crafting table`)
                      // Забрать верстак обратно
                      await bot.dig(tableBlk)
                    }
                  }
                }
              }
            }
          } catch (e) {
            try { this._brain.log.info(`[ResourceSystem] climb: crafting table attempt failed: ${e.message}`) } catch (_) {}
          }
          const crafted = await equipBestPickaxe(bot).catch(() => null)
          if (crafted) return crafted
        }
      }

      // 3. Fallback: топор (рубит камень ~3× медленнее кирки, но работает)
      const axe = findBestAxe(bot)
      if (axe) {
        try { await bot.equip(axe, 'hand') } catch (_) {}
        try { this._brain.log.info(`[ResourceSystem] climb: using ${axe.name} as pickaxe fallback`) } catch (_) {}
        return axe.name
      }

      // 4. Fallback: лопата
      const shovel = findBestShovel(bot)
      if (shovel) {
        try { await bot.equip(shovel, 'hand') } catch (_) {}
        try { this._brain.log.info(`[ResourceSystem] climb: using ${shovel.name} as last resort`) } catch (_) {}
        return shovel.name
      }

      return null // совсем ничего нет
    }

    while (!this._shouldInterrupt()) {
      const pos = bot.entity?.position
      if (!pos) break
      const footY = Math.floor(pos.y)
      if (footY >= DEEP_Y) break

      const bx = Math.floor(pos.x)
      const bz = Math.floor(pos.z)

      // Check for danger directly above — lava stops us
      const above1 = bot.blockAt?.(new Vec3(bx, footY + 2, bz))
      const above2 = bot.blockAt?.(new Vec3(bx, footY + 3, bz))
      if ((above1 && DANGER.test(above1.name)) || (above2 && DANGER.test(above2.name))) {
        try { this._brain.log.info(`[ResourceSystem] climb: danger above (${above1?.name}/${above2?.name}) — stopping vertical ascent`) } catch (_) {}
        break
      }

      // Equip best available tool — handles broken pickaxe mid-climb
      const tool = await _equipBestDigger()
      if (!tool) {
        try { this._brain.log.info(`[ResourceSystem] climb: no digging tool at all — aborting vertical climb`) } catch (_) {}
        try { this._bot.chat(`Сломал кирку под землёй, нечем копать вверх!`) } catch (_) {}
        break
      }

      // Dig the two blocks above head
      for (const dy of [2, 3]) {
        const blk = bot.blockAt?.(new Vec3(bx, footY + dy, bz))
        if (blk && blk.boundingBox === 'block' && !DANGER.test(blk.name)) {
          const isHard = /deepslate|obsidian|ancient_debris/.test(blk.name)
          try {
            await bot.look(0, -Math.PI / 2, true)
            await Promise.race([
              bot.dig(blk, true),
              sleep(isHard ? 10_000 : 4_000)
            ])
          } catch (_) {}
        }
      }

      // Jump up into the cleared space
      bot.setControlState('jump', true)
      await sleep(600)
      bot.setControlState('jump', false)
      await sleep(200)
    }

    try { this._brain.log.info(`[ResourceSystem] climb done at Y=${Math.floor(bot.entity?.position?.y ?? 0)}`) } catch (_) {}
  }

  _tick() {
    if (this._active && this._shouldInterrupt()) this.pauseGather('HOSTILE_CONTACT');
    // Periodic telemetry heartbeat for NULLBIT Launcher (always, even when idle)
    const now = Date.now()
    if (now - this._lastTelemetryEmit > 5000) {
      this._lastTelemetryEmit = now
      try {
        console.log(JSON.stringify({
          type: 'resource',
          trees: this._session.treesComplete,
          ores: this._session.blocksCollected,
          fallbacks: 0,
          dangerStops: 0,
          status: this._active ? (this._phase === 'WORKING' ? 'GATHERING' : 'STANDBY') : 'STANDBY',
          job: this._resourceType || 'none'
        }))
      } catch (_) {}
      // Also emit inventory telemetry as a fallback heartbeat
      try {
        const inv = this._bot?.inventory
        const usedSlots = inv?.slots?.filter(i => i).length || 0
        const totalSlots = 36
        const freeSlots = totalSlots - usedSlots
        console.log(JSON.stringify({
          type: 'inv',
          fillRatio: usedSlots / totalSlots,
          freeSlots,
          usedSlots,
          totalSlots
        }))
      } catch (_) {}
    }
  }

  _onStateChanged(ev) {
    // Update brain state for tests and other systems
    if (this._brain.state && this._brain.state._setState) {
      const state = ev.state || ev.to;
      this._brain.state._setState(state);
    }
    
    const state = ev.state || ev.to;
    const isThreat = state === CoreStates.FLEE || state === CoreStates.COMBAT;
    const nowThreat = isThreat && this._active;
    
    if (nowThreat && !this._paused) {
      this.pauseGather('HOSTILE_CONTACT');
    }
  }

  init() {
    if (this._wired) return;
    this._wired = true;
    this._bus.on(ResourceEvents.GATHER_START, this._onGatherStart);
    this._bus.on(ResourceEvents.GATHER_STOP, this._onGatherStop);
    this._bus.on(CoreEvents.STATE_CHANGED, this._onStateChanged);
    this._bus.on(WatchdogEvents.DEADLOCK_DETECTED, this._onWatchdogDeadlock);
    this._brain.scheduler.registerPeriodic(TICK_INTERVAL, this._tick, { id: TASK_RESOURCE });
  }

  returnToBase() {
    if (this._resourceType && this._resourceType !== 'wood') {
      // This will be picked up by the next ore job iteration
      this._pendingReturnToBase = true;
      if (this._brain.log && this._brain.log.info) {
        this._brain.log.info('[ResourceSystem] returnToBase command queued for ore job');
      }
    } else {
      if (this._brain.log && this._brain.log.info) {
        this._brain.log.info('[ResourceSystem] returnToBase: no active ore job');
      }
    }
  }

  _onWatchdogDeadlock () {
    if (!this._active) return
    try { this._brain.log.warn('[ResourceSystem] watchdog deadlock — graceful exit') } catch (_) {}
    this._bus.emit(NavEvents.STOP, { reason: 'watchdog_deadlock' })
    try { this._bot.clearControlStates?.() } catch (_) {}
    this.pauseGather('WATCHDOG_DEADLOCK')
  }

  destroy() {
    if (!this._wired) return
    this._wired = false
    if (this._active) this.stopGather('SYSTEM_DESTROY')
    this._bus.off(ResourceEvents.GATHER_START, this._onGatherStart)
    this._bus.off(ResourceEvents.GATHER_STOP, this._onGatherStop)
    this._bus.off(CoreEvents.STATE_CHANGED, this._onStateChanged)
    this._bus.off(WatchdogEvents.DEADLOCK_DETECTED, this._onWatchdogDeadlock)
    this._brain.scheduler.unregister(TASK_RESOURCE)
  }
}

module.exports = { ResourceSystem, GATHER_PHASE, LOG_NAME_RE }
