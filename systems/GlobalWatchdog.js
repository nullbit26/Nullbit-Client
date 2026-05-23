'use strict'

const { WatchdogEvents, NavEvents, CoreEvents } = require('../core/EventRegistry')
const { CoreStates } = require('../core/StateManager')

/**
 * Thresholds (ms) per core state before DEADLOCK_DETECTED fires.
 * States not listed here are not monitored (IDLE, etc.).
 */
const DEADLOCK_THRESHOLDS_MS = Object.freeze({
  [CoreStates.COMBAT]:    30_000,
  [CoreStates.FLEE]:      30_000,
  [CoreStates.FOLLOWING]: 90_000,
  // GATHER is not a CoreState — handled via taskState.currentTask.kind === 'gather'
  GATHER:                 90_000
})

/** Warn to console when stuck this long without hitting full deadlock threshold. */
const WARN_THRESHOLD_MS = 30_000

/** How far (in blocks) the bot must move to be considered "not stuck". */
const MOVEMENT_THRESHOLD = 1.0

/** Poll interval in ms. */
const POLL_INTERVAL_MS = 1000

/**
 * GlobalWatchdog — monitors bot position every second and fires
 * `WatchdogEvents.DEADLOCK_DETECTED` if the bot is in an active state
 * and hasn't moved for longer than the configured threshold.
 *
 * Systems that do legitimate "stand-still" work (open chest, craft, eat)
 * should set `brain.watchdogExempt = true` before starting and clear it after.
 *
 * @typedef {Object} GlobalWatchdogCtx
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/BotBrain').BotBrain} brain
 */
class GlobalWatchdog {
  /** @param {GlobalWatchdogCtx} ctx */
  constructor (ctx) {
    if (!ctx?.brain) throw new Error('[GlobalWatchdog] brain is required')
    this._bot = ctx.bot
    this._brain = ctx.brain
    this._bus = ctx.brain.eventBus

    /** @private @type {ReturnType<typeof setInterval> | null} */
    this._interval = null
    /** @private */
    this._wired = false
    /** @private — last known position snapshot */
    this._lastPos = null
    /** @private — when the bot was last seen moving */
    this._lastMovedAt = Date.now()
    /** @private — have we already fired DEADLOCK for this stuck window? */
    this._deadlockFired = false
    /** @private — have we already printed the 30s warning for this stuck window? */
    this._warnFired = false

    this._tick = this._tick.bind(this)
    this._onStateChanged = this._onStateChanged.bind(this)
    
    /** @private Last time watchdog JSON was emitted */
    this._lastJsonEmit = 0
  }

  /** @private Emit watchdog debug JSON for NULLBIT Launcher (throttled: once per 5 sec) */
  _emitWatchdogDebug (extra = {}) {
    try {
      const now = Date.now()
      if (now - this._lastJsonEmit < 5000 && !extra.deadlock) return
      this._lastJsonEmit = now
      
      const coreState = this._brain.state.getState()
      const taskKind = this._brain.taskState?.currentTask?.kind ?? null
      const stuckMs = this._lastMovedAt ? now - this._lastMovedAt : 0
      const isStuck = stuckMs >= WARN_THRESHOLD_MS
      
      const payload = {
        type: 'watchdog',
        lastCheck: new Date().toLocaleTimeString(),
        lockHolder: this._brain.watchdogExempt ? (taskKind || 'exempt') : (taskKind || 'NONE'),
        pathStatus: isStuck ? (stuckMs >= (DEADLOCK_THRESHOLDS_MS[coreState] || 30000) ? 'deadlock' : 'stuck') : 'ok',
        status: this._brain.watchdogExempt ? 'EXEMPT' : (isStuck ? 'STUCK' : 'ACTIVE'),
        ...extra
      }
      console.log(JSON.stringify(payload))
    } catch (_) {}
  }

  // ─────────────────────────────── public API ───────────────────────────────

  init () {
    if (this._wired) return
    this._wired = true
    this._reset()
    this._interval = setInterval(this._tick, POLL_INTERVAL_MS)
    this._bus.on(CoreEvents.STATE_CHANGED, this._onStateChanged)
    try { this._brain.log.info('[GlobalWatchdog] started') } catch (_) {}
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    if (this._interval != null) {
      clearInterval(this._interval)
      this._interval = null
    }
    this._bus.off(CoreEvents.STATE_CHANGED, this._onStateChanged)
    try { this._brain.log.info('[GlobalWatchdog] stopped') } catch (_) {}
  }

  // ──────────────────────────── private helpers ─────────────────────────────

  /** Reset stuck tracking (called on state change or after deadlock fires). */
  _reset () {
    const pos = this._bot.entity?.position
    this._lastPos = pos ? { x: pos.x, y: pos.y, z: pos.z } : null
    this._lastMovedAt = Date.now()
    this._deadlockFired = false
    this._warnFired = false
  }

  /** @private */
  _onStateChanged () {
    this._reset()
  }

  /** @private — returns threshold ms for current bot state, or null if exempt */
  _getThresholdMs () {
    const coreState = this._brain.state.getState()

    // Never monitor IDLE — bot is supposed to be still
    if (coreState === CoreStates.IDLE) return null

    // Explicit exempt flag set by StorageSystem / CraftingSystem / etc.
    if (this._brain.watchdogExempt) return null

    // RecoveryHold active — bot is intentionally paused
    if (this._brain.recoveryHoldSystem?.isActive?.()) return null

    // GATHER is tracked via taskState, not CoreState
    const task = this._brain.taskState?.currentTask
    if (task?.kind === 'gather') {
      return DEADLOCK_THRESHOLDS_MS.GATHER
    }

    return DEADLOCK_THRESHOLDS_MS[coreState] ?? null
  }

  /** @private — main poll tick */
  _tick () {
    try {
      const threshold = this._getThresholdMs()
      if (threshold == null) {
        // In exempt / IDLE — keep resetting so we don't carry over stale timer
        const pos = this._bot.entity?.position
        if (pos) {
          const lp = this._lastPos
          const moved = !lp ||
            Math.abs(pos.x - lp.x) > MOVEMENT_THRESHOLD ||
            Math.abs(pos.y - lp.y) > MOVEMENT_THRESHOLD ||
            Math.abs(pos.z - lp.z) > MOVEMENT_THRESHOLD
          if (moved) {
            this._lastPos = { x: pos.x, y: pos.y, z: pos.z }
            this._lastMovedAt = Date.now()
            this._deadlockFired = false
            this._warnFired = false
          }
        }
        // Still emit heartbeat telemetry even in IDLE so launcher shows ACTIVE not OFFLINE
        this._emitWatchdogDebug()
        return
      }

      const pos = this._bot.entity?.position
      if (!pos) return

      const lp = this._lastPos
      const moved = !lp ||
        Math.abs(pos.x - lp.x) > MOVEMENT_THRESHOLD ||
        Math.abs(pos.y - lp.y) > MOVEMENT_THRESHOLD ||
        Math.abs(pos.z - lp.z) > MOVEMENT_THRESHOLD

      if (moved) {
        this._lastPos = { x: pos.x, y: pos.y, z: pos.z }
        this._lastMovedAt = Date.now()
        this._deadlockFired = false
        this._warnFired = false
        return
      }

      const stuckMs = Date.now() - this._lastMovedAt
      const coreState = this._brain.state.getState()
      const taskKind = this._brain.taskState?.currentTask?.kind ?? null

      // Emit JSON telemetry (throttled)
      this._emitWatchdogDebug()

      // 30s warning
      if (!this._warnFired && stuckMs >= WARN_THRESHOLD_MS) {
        this._warnFired = true
        const msg = `[GlobalWatchdog] Бот простаивает ${Math.floor(stuckMs / 1000)}с. Текущее состояние: ${coreState}, Текущая задача: ${taskKind ?? 'нет'}`
        try { this._brain.log.warn(msg) } catch (_) { console.warn(msg) }
      }

      // Full deadlock threshold
      if (!this._deadlockFired && stuckMs >= threshold) {
        this._deadlockFired = true
        this._fireDeadlock(coreState, taskKind, stuckMs)
      }
    } catch (e) {
      try { this._brain.log.warn('[GlobalWatchdog] tick error:', e?.message) } catch (_) {}
    }
  }

  /**
   * @private
   * @param {string} coreState
   * @param {string|null} taskKind
   * @param {number} stuckMs
   */
  _fireDeadlock (coreState, taskKind, stuckMs) {
    // Emit deadlock JSON immediately
    this._emitWatchdogDebug({ deadlock: true, coreState, taskKind, stuckSeconds: Math.floor(stuckMs / 1000) })
    
    const msg = `[GlobalWatchdog] ОБНАРУЖЕНО КРИТИЧЕСКОЕ ЗАВИСАНИЕ! Принудительный сброс системы... Текущее состояние было: ${coreState}, задача: ${taskKind ?? 'нет'}, простой: ${Math.floor(stuckMs / 1000)}с`
    try { this._brain.log.error(msg) } catch (_) { console.error(msg) }

    try { this._bot.chat(`[Watchdog] Зависание обнаружено (${coreState}/${taskKind ?? 'нет'}). Перезапуск...`) } catch (_) {}

    // 1. Stop pathfinder
    try {
      this._bot.pathfinder?.stop?.()
      this._bot.pathfinder?.setGoal?.(null)
    } catch (_) {}

    // 2. Release all keys
    try { this._bot.clearControlStates?.() } catch (_) {}

    // 3. Stop nav via bus
    try { this._bus.emit(NavEvents.STOP, { reason: 'watchdog_reset' }) } catch (_) {}

    // 4. Emit DEADLOCK_DETECTED — systems do their own graceful exit
    try {
      this._bus.emit(WatchdogEvents.DEADLOCK_DETECTED, {
        coreState,
        taskKind: taskKind ?? undefined,
        stuckMs,
        at: Date.now()
      })
    } catch (_) {}

    // 5. After systems had a tick to clean up, force IDLE
    setTimeout(() => {
      try {
        if (this._brain.state.getState() !== CoreStates.IDLE) {
          this._brain.state.transition(CoreStates.IDLE, { reason: 'watchdog_reset' })
        }
      } catch (_) {}

      // 6. Enter RecoveryHold with deadlock reason so jitter-escape runs
      try {
        this._brain.recoveryHoldSystem?.enter?.('WATCHDOG_DEADLOCK')
      } catch (_) {}

      // 7. Reset our own timer so we don't re-fire immediately
      this._reset()
    }, 200)
  }
}

module.exports = { GlobalWatchdog }
