'use strict'

const { DefendEvents } = require('../core/EventRegistry')

/**
 * Bus entry points for defend/patrol/point/entity modes. Behavior remains in `defend.js`;
 * this class centralizes EventBus wiring and BotBrain lifecycle.
 *
 * **Patrol:** ring `patrolMode` and defend-point patrol legs are **off by default** (`config.defendPatrolEnabled`).
 * Opt-in with `PATROL_ENABLED=1` (experimental).
 *
 * Threat selection and non-party rules use {@link ../systems/PartyIFFSystem} via `bot.partyIFF`
 * inside `defend.js` (`findThreat` → `isDefenseThreatEntity`).
 *
 * **Nav yield (COMBAT / FLEE):** `defend.js` must not issue patrol / defend legs while
 * `StateManager` is `COMBAT` or `FLEE`, or while `attackEntity` has an active session
 * (`isCombatSessionActive`). Wire `getCoreState`, `eventBus`, and `NavEvents` from `startBot.js`
 * into `createDefend` so bus-driven defend legs use `nav:goto` + wait and do not steal pathfinder from combat.
 *
 * @typedef {Object} DefendSystemCtx
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/BotBrain').BotBrain} brain
 * @property {any} defend — return value of `createDefend`
 */

class DefendSystem {
  /**
   * @param {DefendSystemCtx} ctx
   */
  constructor (ctx) {
    if (!ctx?.brain) throw new Error('[DefendSystem] brain is required')
    if (!ctx?.defend) throw new Error('[DefendSystem] defend is required')
    this._brain = ctx.brain
    this._bus = ctx.brain.eventBus
    this._defend = ctx.defend

    this._onPatrol = this._onPatrol.bind(this)
    this._onPoint = this._onPoint.bind(this)
    this._onEntity = this._onEntity.bind(this)
    this._onStopAll = this._onStopAll.bind(this)

    /** @private */
    this._wired = false
  }

  /** @private */
  _onPatrol (p) {
    this._brain.setLastMode({ type: 'patrol', params: (p && p.params) || {} })
    void this._defend.patrolMode((p && p.params) || {}).catch(() => {})
  }

  /** @private */
  _onPoint (p) {
    this._brain.setLastMode({ type: 'defend_point', params: (p && p.params) || {} })
    void this._defend.defendPoint((p && p.params) || {}).catch(() => {})
  }

  /** @private */
  _onEntity (p) {
    this._brain.setLastMode({ type: 'defend_entity', params: (p && p.params) || {} })
    void this._defend.defendEntity((p && p.params) || {}).catch(() => {})
  }

  /** @private */
  _onStopAll () {
    this._brain.setLastMode(null)
    this._defend.stopAllDefend({ silent: true })
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bus.on(DefendEvents.PATROL_MODE, this._onPatrol)
    this._bus.on(DefendEvents.DEFEND_POINT, this._onPoint)
    this._bus.on(DefendEvents.DEFEND_ENTITY, this._onEntity)
    this._bus.on(DefendEvents.STOP_ALL, this._onStopAll)
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._bus.off(DefendEvents.PATROL_MODE, this._onPatrol)
    this._bus.off(DefendEvents.DEFEND_POINT, this._onPoint)
    this._bus.off(DefendEvents.DEFEND_ENTITY, this._onEntity)
    this._bus.off(DefendEvents.STOP_ALL, this._onStopAll)
  }
}

module.exports = { DefendSystem }
