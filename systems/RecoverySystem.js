'use strict'

const { NavEvents } = require('../core/EventRegistry')

/**
 * Coordinates nav failure fallbacks and optional auto-reconnect.
 * Pathfinder throttles / `handleStuckRecovery` remain in `actions/movement.js` (frozen stack);
 * this layer reacts to bus + session lifecycle without changing movement internals.
 */
class RecoverySystem {
  /**
   * @param {object} opts
   * @param {import('mineflayer').Bot} opts.bot
   * @param {import('../core/EventBus').EventBus} opts.eventBus
   * @param {object} opts.config
   * @param {object} opts.state
   * @param {object} opts.movementActions
   * @param {import('../utils/Logger').Logger} [opts.logger]
   * @param {{ schedule: (reason: string) => void, isShuttingDown?: () => boolean } | null} [opts.reconnect]
   */
  constructor (opts) {
    if (!opts?.bot) throw new Error('[RecoverySystem] bot is required')
    if (!opts?.eventBus) throw new Error('[RecoverySystem] eventBus is required')
    if (!opts?.config) throw new Error('[RecoverySystem] config is required')
    if (!opts?.state) throw new Error('[RecoverySystem] state is required')
    if (!opts?.movementActions) throw new Error('[RecoverySystem] movementActions is required')

    this._bot = opts.bot
    this._bus = opts.eventBus
    this._config = opts.config
    this._state = opts.state
    this._movement = opts.movementActions
    this._log = opts.logger ? opts.logger.child(' [RECOV]') : require('../utils/Logger').createLogger({ prefix: '[RECOV]' })
    this._reconnect = opts.reconnect || null

    this._onPathResult = this._onPathResult.bind(this)
    this._onNavRecovery = this._onNavRecovery.bind(this)
    this._onBotEnd = this._onBotEnd.bind(this)

    /** @private */
    this._wired = false
  }

  /** @private @param {import('../core/EventRegistry').NavPathResultPayload} payload */
  _onPathResult (payload) {
    const st = payload && typeof payload.status === 'string' ? payload.status : undefined
    if (st === 'success' && typeof this._movement.resetNoPathRecoveryBackoff === 'function') {
      this._movement.resetNoPathRecoveryBackoff()
    }
    if (this._config.pathDigPreferWalk && this._config.pathAllowDigNatural && this._movement.setPathfinderDigEnabled) {
      if (st === 'noPath' || st === 'timeout') {
        this._movement.setPathfinderDigEnabled(true)
      } else if (st === 'success') {
        this._movement.setPathfinderDigEnabled(false)
      }
    }
  }

  /** @private @param {import('../core/EventRegistry').NavRecoveryPayload} payload */
  _onNavRecovery (payload) {
    const ctx = payload && typeof payload.context === 'string' ? payload.context : 'nav_recovery'
    const status = payload && typeof payload.status === 'string' ? payload.status : undefined
    if (this._config.pathDigPreferWalk && this._config.pathAllowDigNatural && this._movement.setPathfinderDigEnabled) {
      this._movement.setPathfinderDigEnabled(true)
    }
    let recovered = false
    if (typeof this._movement.handleStuckRecovery === 'function') {
      recovered = !!this._movement.handleStuckRecovery(ctx)
    }
    const at = Date.now()
    this._bus.emit(NavEvents.STUCK, {
      context: ctx,
      status,
      at,
      recovered
    })
    this._log.info('nav recovery', { context: ctx, status, recovered })
  }

  /** @private @param {unknown} reason */
  _onBotEnd (reason) {
    const r = reason != null ? String(reason) : ''
    if (this._reconnect?.schedule && this._config.autoReconnectEnabled) {
      if (typeof this._reconnect.isShuttingDown === 'function' && this._reconnect.isShuttingDown()) return
      if (this._state.reconnectTimer) return
      this._state.reconnectAttempts = (this._state.reconnectAttempts || 0) + 1
      const cap = Number(this._config.reconnectMaxDelayMs) || 30000
      const delay = Math.min(1000 * 2 ** (this._state.reconnectAttempts - 1), cap)
      this._log.info(`scheduling reconnect in ${delay}ms`, { reason: r, attempt: this._state.reconnectAttempts })
      this._state.reconnectTimer = setTimeout(() => {
        this._state.reconnectTimer = null
        try {
          this._reconnect.schedule(r)
        } catch (e) {
          this._log.error('reconnect schedule failed', e instanceof Error ? e.message : String(e))
        }
      }, delay)
    }
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bus.on(NavEvents.PATH_RESULT, this._onPathResult)
    this._bus.on(NavEvents.RECOVERY, this._onNavRecovery)
    // Run before other `end` handlers (e.g. `brain.destroy`) so reconnect can be scheduled first.
    if (typeof this._bot.prependOnceListener === 'function') {
      this._bot.prependOnceListener('end', this._onBotEnd)
    } else {
      this._bot.once('end', this._onBotEnd)
    }
    this._log.info('wired')
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._bus.off(NavEvents.PATH_RESULT, this._onPathResult)
    this._bus.off(NavEvents.RECOVERY, this._onNavRecovery)
    try {
      this._bot.removeListener('end', this._onBotEnd)
    } catch (_) {}
    this._log.info('unwired')
  }
}

module.exports = { RecoverySystem }
