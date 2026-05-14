'use strict'

const { goals } = require('mineflayer-pathfinder')
const { NavEvents } = require('../core/EventRegistry')
const { isCombatSessionActive } = require('../attackEntity')
const { HazardEvaluator } = require('./HazardEvaluator')
const AntiStuck = require('./AntiStuck')

const RECOVERY_DEBOUNCE_MS = 4000

/**
 * Pathfinder-facing adapter: bus commands → `setGoal` / stop; bot `path_update` → bus status.
 * Does not replace `movement.js` follow/guard — parallel control surface for Step 2+ wiring.
 *
 * @typedef {Object} NavigationControllerOptions
 * @property {import('../core/EventBus').EventBus} eventBus
 * @property {import('../utils/Logger').Logger} logger — parent logger; we use `.child(' [NAV]')`
 */

class NavigationController {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {NavigationControllerOptions} options
   */
  constructor (bot, options) {
    if (!bot) throw new Error('[NavigationController] bot is required')
    if (!options?.eventBus) throw new Error('[NavigationController] eventBus is required')

    /** @readonly */
    this.bot = bot
    /** @private @type {import('../core/EventBus').EventBus} */
    this._bus = options.eventBus
    /** @private @type {import('../utils/Logger').Logger} */
    this._log = options.logger
      ? options.logger.child(' [NAV]')
      : require('../utils/Logger').createLogger({ prefix: '[NAV]' })

    /** @readonly — hazard math for future nav-aware goals */
    this.hazardEvaluator = new HazardEvaluator()

    /** @readonly — legacy anti-stuck API surface (movement still owns runtime ctx) */
    this.antiStuck = AntiStuck

    /** @private */
    this._onGoto = this._onGoto.bind(this)
    /** @private */
    this._onStop = this._onStop.bind(this)
    /** @private */
    this._onPathUpdate = this._onPathUpdate.bind(this)
    /** @private */
    this._onGoalReached = this._onGoalReached.bind(this)
    /** @private */
    this._lastRecoveryEmitAt = 0
    /** @private */
    this._wired = false
  }

  /** @private @param {import('../core/EventRegistry').NavGotoPayload} payload */
  _onGoto (payload) {
    if (!payload || typeof payload !== 'object') {
      this._log.warn('nav:goto ignored (bad payload)')
      return
    }
    if (isCombatSessionActive()) {
      this._log.info('nav:goto ignored (combat session owns pathfinder)')
      return
    }
    if (!this.bot.pathfinder || typeof this.bot.pathfinder.setGoal !== 'function') {
      this._log.warn('nav:goto ignored (no pathfinder)')
      return
    }
    if (payload.kind !== 'near') {
      this._log.warn('nav:goto unsupported kind', String(payload.kind))
      return
    }
    const x = Number(payload.x)
    const y = Number(payload.y)
    const z = Number(payload.z)
    if (![x, y, z].every(Number.isFinite)) {
      this._log.warn('nav:goto near needs finite x,y,z')
      return
    }
    const range = Number.isFinite(Number(payload.range)) ? Number(payload.range) : 2
    this.bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range), true)
    this._bus.emit(NavEvents.GOAL_SET, { kind: 'near', x, y, z, range, at: Date.now() })
    this._log.info(`goal near (${x}, ${y}, ${z}) r=${range}`)
  }

  /** @private @param {import('../core/EventRegistry').NavStopPayload} [payload] */
  _onStop (payload) {
    if (isCombatSessionActive()) {
      this._log.info('nav:stop ignored (combat session owns pathfinder)')
      return
    }
    if (this.bot.pathfinder && typeof this.bot.pathfinder.setGoal === 'function') {
      this.bot.pathfinder.setGoal(null)
    }
    this._bus.emit(NavEvents.GOAL_SET, {
      kind: 'cleared',
      at: Date.now(),
      reason: payload && typeof payload.reason === 'string' ? payload.reason : undefined
    })
    this._log.info('stop / goal cleared')
  }

  /** @private @param {import('mineflayer').Bot['path_update']} res */
  _onPathUpdate (res) {
    const status = res && typeof res.status === 'string' ? res.status : undefined
    this._bus.emit(NavEvents.PATH_RESULT, {
      status,
      rawStatus: status,
      at: Date.now()
    })
    if (status === 'noPath' || status === 'timeout') {
      const now = Date.now()
      if (now - this._lastRecoveryEmitAt >= RECOVERY_DEBOUNCE_MS) {
        this._lastRecoveryEmitAt = now
        this._bus.emit(NavEvents.RECOVERY, { context: `path_${status || 'unknown'}`, status, at: now })
      }
    }
  }

  /** @private */
  _onGoalReached () {
    this._bus.emit(NavEvents.ARRIVED, { at: Date.now(), source: 'pathfinder' })
    this._log.info('arrived (goal_reached)')
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bus.on(NavEvents.GOTO, this._onGoto)
    this._bus.on(NavEvents.STOP, this._onStop)
    this.bot.on('path_update', this._onPathUpdate)
    this.bot.on('goal_reached', this._onGoalReached)
    this._log.info('NavigationController wired')
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._bus.off(NavEvents.GOTO, this._onGoto)
    this._bus.off(NavEvents.STOP, this._onStop)
    this.bot.removeListener('path_update', this._onPathUpdate)
    this.bot.removeListener('goal_reached', this._onGoalReached)
    this._log.info('NavigationController unwired')
  }
}

module.exports = { NavigationController }
