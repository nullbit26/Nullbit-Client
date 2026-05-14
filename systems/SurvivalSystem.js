'use strict'

const { SurvivalEvents } = require('../core/EventRegistry')
const { CoreStates } = require('../core/StateManager')
const { isCombatSessionActive } = require('../attackEntity')
const { evaluateThreatPressure } = require('../combat/flee/evaluateThreatPressure')

const TASK_SURVIVAL = 'survival_system_tick'
const TICK_INTERVAL = 20 // ~1 s at 20 TPS
const EAT_FAIL_COOLDOWN_MS = 5000

/** Еда, которую не пытаемся есть (яд / дебаффы). */
const FOOD_DENYLIST = new Set([
  'rotten_flesh',
  'spider_eye',
  'pufferfish',
  'poisonous_potato',
  'chorus_fruit'
])

/**
 * Лучшая еда из инвентаря по `effectiveQuality`.
 * @param {import('mineflayer').Bot} bot
 * @returns {import('mineflayer').Item | null}
 */
function findBestFood (bot) {
  const byName = bot.registry?.foodsByName
  if (!byName) return null
  let best = null
  let bestQ = -1
  for (const item of bot.inventory.items()) {
    if (!item?.name || FOOD_DENYLIST.has(item.name)) continue
    const fd = byName[item.name]
    if (!fd) continue
    const q = Number(fd.effectiveQuality ?? fd.foodPoints ?? 0)
    if (q > bestQ) {
      bestQ = q
      best = item
    }
  }
  return best
}

/**
 * Survival v1 — thin self-preservation policy layer.
 *
 * - Enabled/disabled via bus events (`survival:set` / `survival:stop`).
 * - Periodic tick via {@link ../core/Scheduler} — checks safety, eats when hungry.
 * - Yields to COMBAT / FLEE / active combat session — never conflicts with CombatSystem.
 * - Does NOT own pathfinder or navigation.
 *
 * @typedef {Object} SurvivalSystemCtx
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/BotBrain').BotBrain} brain
 * @property {any} config
 */

class SurvivalSystem {
  /**
   * @param {SurvivalSystemCtx} ctx
   */
  constructor (ctx) {
    if (!ctx?.brain) throw new Error('[SurvivalSystem] brain is required')
    this._bot = ctx.bot
    this._brain = ctx.brain
    this._bus = ctx.brain.eventBus
    this._memory = ctx.brain.memory
    this._config = ctx.config

    /** @private */
    this._active = false
    /** @private */
    this._isEating = false
    /** @private */
    this._eatCooldownUntil = 0
    /** @private */
    this._wired = false

    this._onSet = this._onSet.bind(this)
    this._onStop = this._onStop.bind(this)
    this._onSpawn = this._onSpawn.bind(this)
    this._tick = this._tick.bind(this)
  }

  /** @returns {boolean} Whether survival mode is currently enabled. */
  isActive () {
    return this._active
  }

  /** @private */
  _onSet () {
    this._active = true
    try { this._brain.log.info('[SurvivalSystem] activated') } catch (_) {}
  }

  /** @private */
  _onStop () {
    this._active = false
    this._isEating = false
    this._eatCooldownUntil = 0
    try { this._brain.log.info('[SurvivalSystem] deactivated') } catch (_) {}
  }

  /** @private — reset transient state on respawn, keep _active as user-requested */
  _onSpawn () {
    this._isEating = false
    this._eatCooldownUntil = 0
  }

  /** @private — scheduler callback */
  _tick () {
    if (!this._active) return

    const coreState = this._brain.state.getState()
    if (coreState === CoreStates.COMBAT || coreState === CoreStates.FLEE) return
    if (isCombatSessionActive()) return
    if (this._isEating) return
    if (Date.now() < this._eatCooldownUntil) return

    const pressure = evaluateThreatPressure(this._bot, this._memory, this._config)
    if (pressure.immediateDanger || !pressure.safeToRecover) return

    const foodThreshold = Math.max(1, Math.min(20, Number(this._config.survivalEatBelowFood) || 18))
    const food = Number(this._bot.food)
    if (!Number.isFinite(food) || food >= foodThreshold) return

    const item = findBestFood(this._bot)
    if (!item) return

    this._tryEat(item)
  }

  /**
   * Fire-and-forget async eat with guard flag.
   * @private
   * @param {import('mineflayer').Item} item
   */
  _tryEat (item) {
    if (this._isEating) return
    this._isEating = true
    ;(async () => {
      try {
        await this._bot.equip(item, 'hand')
        await this._bot.consume()
        try { this._brain.log.info('[SurvivalSystem] ate', item.name) } catch (_) {}
      } catch (e) {
        this._eatCooldownUntil = Date.now() + EAT_FAIL_COOLDOWN_MS
        try { this._brain.log.warn('[SurvivalSystem] eat failed', e?.message || e) } catch (_) {}
      } finally {
        this._isEating = false
      }
    })()
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bus.on(SurvivalEvents.SET_SURVIVAL, this._onSet)
    this._bus.on(SurvivalEvents.STOP_SURVIVAL, this._onStop)
    this._bot.on('spawn', this._onSpawn)
    this._brain.scheduler.registerPeriodic(TICK_INTERVAL, this._tick, { id: TASK_SURVIVAL })
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._active = false
    this._isEating = false
    this._eatCooldownUntil = 0
    this._bot.removeListener('spawn', this._onSpawn)
    this._brain.scheduler.unregister(TASK_SURVIVAL)
    this._bus.off(SurvivalEvents.SET_SURVIVAL, this._onSet)
    this._bus.off(SurvivalEvents.STOP_SURVIVAL, this._onStop)
  }
}

module.exports = { SurvivalSystem }
