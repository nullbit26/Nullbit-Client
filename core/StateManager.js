'use strict'

const { CoreEvents } = require('./EventRegistry')

/**
 * High-level FSM for orchestration. Gameplay systems will align with these states in later steps.
 *
 * @typedef {'IDLE' | 'FOLLOWING' | 'COMBAT' | 'FLEE'} CoreStateId
 */

/** @type {Readonly<Record<string, CoreStateId>>} */
const CoreStates = Object.freeze({
  IDLE: 'IDLE',
  FOLLOWING: 'FOLLOWING',
  COMBAT: 'COMBAT',
  /** Low HP: combat aborted, bus-driven retreat + healing (see {@link ../systems/CombatSystem}). */
  FLEE: 'FLEE'
})

/** @type {ReadonlySet<CoreStateId>} */
const VALID_STATE_IDS = new Set(Object.values(CoreStates))

class StateManager {
  /**
   * @param {import('./EventBus').EventBus} eventBus
   */
  constructor (eventBus) {
    if (!eventBus || typeof eventBus.emit !== 'function') {
      throw new Error('[StateManager] EventBus is required')
    }
    /** @private */
    this._bus = eventBus
    /** @private @type {CoreStateId} */
    this._state = CoreStates.IDLE
  }

  /** @returns {CoreStateId} */
  getState () {
    return this._state
  }

  /**
   * Transition to a new state; no-op if already `to`.
   * @param {CoreStateId} to
   * @param {Object} [meta]
   */
  transition (to, meta) {
    const next = /** @type {CoreStateId} */ (String(to))
    if (!VALID_STATE_IDS.has(next)) {
      throw new Error(`[StateManager] Unknown state: ${String(to)}`)
    }
    if (next === this._state) return

    const from = this._state
    this._state = next
    this._bus.emit(CoreEvents.STATE_CHANGED, {
      from,
      to: next,
      at: Date.now(),
      meta: meta && typeof meta === 'object' ? meta : undefined
    })
  }

  /** @returns {Readonly<typeof CoreStates>} */
  static get States () {
    return CoreStates
  }
}

module.exports = { StateManager, CoreStates }
