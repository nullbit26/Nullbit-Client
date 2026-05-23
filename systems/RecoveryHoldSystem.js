'use strict'

const { CoreEvents, RecoveryHoldEvents } = require('../core/EventRegistry')
const { CoreStates } = require('../core/StateManager')
const { isCombatSessionActive } = require('../attackEntity')
const { evaluateThreatPressure } = require('../combat/flee/evaluateThreatPressure')
const { hasAnyFood } = require('../utils/inventoryValue')

const TASK_RECOVERY_HOLD = 'recovery_hold_system_tick'
const EAT_COOLDOWN_MS = 3000

/** Food items that give debuffs (avoid eating these). */
const FOOD_DENYLIST = new Set([
  'rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'chorus_fruit'
])
const TICK_INTERVAL = 10 // ~0.5 s at 20 TPS

/** Reasons that trigger auto-entry. */
const REASONS = Object.freeze({
  POST_FLEE: 'POST_FLEE',
  POST_COMBAT: 'POST_COMBAT',
  GATHER_INTERRUPTED: 'GATHER_INTERRUPTED',
  MAX_HOLD_TIMEOUT: 'MAX_HOLD_TIMEOUT',
  WATCHDOG_DEADLOCK: 'WATCHDOG_DEADLOCK',
  MANUAL: 'MANUAL'
})

/**
 * Transitional safety state entered after high-pressure events (FLEE exit, combat end, gather interrupt).
 * Blocks risky actions for a configurable minimum window, then releases when conditions are safe.
 *
 * Priority: CombatSystem > RecoveryHoldSystem.
 * - Does NOT own pathfinder.
 * - Does NOT decide combat.
 * - Simply signals "not yet safe to resume risky tasks".
 *
 * @typedef {Object} RecoveryHoldSystemCtx
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/BotBrain').BotBrain} brain
 * @property {any} config
 */

class RecoveryHoldSystem {
  /**
   * @param {RecoveryHoldSystemCtx} ctx
   */
  constructor (ctx) {
    if (!ctx?.brain) throw new Error('[RecoveryHoldSystem] brain is required')
    this._bot = ctx.bot
    this._brain = ctx.brain
    this._bus = ctx.brain.eventBus
    this._config = ctx.config

    /** @private */
    this._active = false
    /** @private */
    this._enteredAt = 0
    /** @private @type {string | null} */
    this._reason = null
    /** @private */
    this._wired = false
    /** @private */
    this._isEating = false
    /** @private */
    this._eatCooldownUntil = 0

    this._onStateChanged = this._onStateChanged.bind(this)
    this._tick = this._tick.bind(this)
  }

  /** @returns {boolean} */
  isActive () {
    return this._active
  }

  /** @returns {{ reason: string, enteredAt: number, heldMs: number } | null} */
  getState () {
    if (!this._active) return null
    return {
      reason: this._reason || 'UNKNOWN',
      enteredAt: this._enteredAt,
      heldMs: Date.now() - this._enteredAt
    }
  }

  /**
   * Manually enter recovery hold (e.g. from ResourceSystem on gather interrupt).
   * @param {string} [reason]
   */
  enter (reason) {
    const r = String(reason || REASONS.MANUAL)
    if (this._active) {
      try { this._brain.log.info('[RecoveryHoldSystem] re-entering hold, reason:', r) } catch (_) {}
      this._reason = r
      this._enteredAt = Date.now()
      return
    }
    this._active = true
    this._enteredAt = Date.now()
    this._reason = r
    try { this._brain.log.info('[RecoveryHoldSystem] enter hold, reason:', r) } catch (_) {}
    this._bus.emit(RecoveryHoldEvents.ENTER, { reason: r, at: this._enteredAt })

    if (r === REASONS.WATCHDOG_DEADLOCK) {
      this._doJitterEscape()
    }
  }

  /**
   * Short jitter-escape movement to unstick bot from phantom blocks / stuck positions.
   * Jump + random lateral strafe for 800ms then stop.
   * @private
   */
  _doJitterEscape () {
    const bot = this._bot
    try {
      const directions = ['left', 'right', 'back', 'forward']
      const dir = directions[Math.floor(Math.random() * directions.length)]
      bot.setControlState('jump', true)
      bot.setControlState(dir, true)
      bot.setControlState('sprint', true)
      setTimeout(() => {
        try {
          bot.clearControlStates?.()
        } catch (_) {}
      }, 800)
      try { this._brain.log.info('[RecoveryHoldSystem] jitter-escape: jump +', dir, '800ms') } catch (_) {}
    } catch (e) {
      try { this._brain.log.warn('[RecoveryHoldSystem] jitter-escape failed:', e?.message) } catch (_) {}
    }
  }

  /** @private */
  _exit (reason) {
    if (!this._active) return
    const heldMs = Date.now() - this._enteredAt
    this._active = false
    this._reason = null
    try { this._brain.log.info('[RecoveryHoldSystem] exit hold, reason:', reason, 'heldMs:', heldMs) } catch (_) {}
    this._bus.emit(RecoveryHoldEvents.EXIT, { reason: String(reason || 'SAFE'), at: Date.now(), heldMs })
  }

  /** @private — reacts to FSM state changes for automatic hold entry */
  _onStateChanged (payload) {
    const { from, to } = payload || {}
    if (from === CoreStates.FLEE && (to === CoreStates.IDLE || to === CoreStates.FOLLOWING)) {
      this.enter(REASONS.POST_FLEE)
    }
  }

  /** @private — scheduler callback */
  _tick () {
    if (!this._active) return

    const now = Date.now()
    const elapsed = now - this._enteredAt
    const cfgMin = this._config?.recoveryHoldMinMs
    const cfgMax = this._config?.recoveryHoldMaxMs
    const minHoldMs = Math.max(0, cfgMin != null ? Number(cfgMin) : 4000)
    const maxHoldMs = Math.max(minHoldMs + 1, cfgMax != null ? Number(cfgMax) : 8000)

    if (elapsed >= maxHoldMs) {
      this._exit(REASONS.MAX_HOLD_TIMEOUT)
      return
    }

    if (elapsed < minHoldMs) return

    if (isCombatSessionActive()) return

    const coreState = this._brain.state.getState()
    if (coreState === CoreStates.FLEE || coreState === CoreStates.COMBAT) return

    const pressure = evaluateThreatPressure(this._bot, this._brain.memory, this._config)
    if (pressure.immediateDanger || pressure.recentAggroPressure) return

    const safeHp = Math.max(6, Number(this._config?.combatFleeSafeHp) || 14)
    const hp = Number(this._bot.health)
    const food = Number(this._bot.food)

    // Auto-eat to heal if hungry and have food
    if (food < 20 && hp < safeHp && hasAnyFood(this._bot)) {
      this._tryEatToHeal()
      return  // Wait for next tick to check if healing succeeded
    }

    // Wait for HP to regenerate if below safe threshold
    if (hp < safeHp) return

    this._exit('SAFE')
  }

  /**
   * Try to eat food to heal. Fire-and-forget async.
   * @private
   */
  _tryEatToHeal () {
    if (this._isEating) return
    if (Date.now() < this._eatCooldownUntil) return

    // Find best food (avoid bad food)
    const items = this._bot.inventory?.items() || []
    let bestFood = null
    let bestQuality = -1
    const foodsByName = this._bot.registry?.foodsByName

    for (const item of items) {
      if (!item?.name || FOOD_DENYLIST.has(item.name)) continue
      if (!foodsByName?.[item.name]) continue
      const fd = foodsByName[item.name]
      const quality = Number(fd.effectiveQuality ?? fd.foodPoints ?? 0)
      if (quality > bestQuality) {
        bestQuality = quality
        bestFood = item
      }
    }

    if (!bestFood) return

    this._isEating = true
    ;(async () => {
      try {
        await this._bot.equip(bestFood, 'hand')
        await this._bot.consume()
        try { this._brain.log.info('[RecoveryHoldSystem] ate', bestFood.name, 'to heal') } catch (_) {}
      } catch (e) {
        this._eatCooldownUntil = Date.now() + EAT_COOLDOWN_MS
        try { this._brain.log.warn('[RecoveryHoldSystem] eat failed:', e?.message) } catch (_) {}
      } finally {
        this._isEating = false
      }
    })()
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bus.on(CoreEvents.STATE_CHANGED, this._onStateChanged)
    this._brain.scheduler.registerPeriodic(TICK_INTERVAL, this._tick, { id: TASK_RECOVERY_HOLD })
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._active = false
    this._enteredAt = 0
    this._reason = null
    this._isEating = false
    this._eatCooldownUntil = 0
    this._bus.off(CoreEvents.STATE_CHANGED, this._onStateChanged)
    this._brain.scheduler.unregister(TASK_RECOVERY_HOLD)
  }
}

module.exports = { RecoveryHoldSystem, RECOVERY_HOLD_REASONS: REASONS }
