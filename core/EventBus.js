'use strict'

const EventEmitter = require('events')
const { isRegisteredBusEvent } = require('./EventRegistry')

/**
 * Centralized event bus: all emits/listeners go through here with strict event names.
 *
 * @extends {EventEmitter}
 */
class EventBus extends EventEmitter {
  constructor (options = {}) {
    super()
    /** @private @type {boolean} */
    this._strict = options.strict !== false
    this.setMaxListeners(options.maxListeners ?? 50)
  }

  /**
   * @param {string} eventName
   * @param {...unknown} args
   * @returns {boolean}
   */
  emit (eventName, ...args) {
    if (this._strict && !isRegisteredBusEvent(eventName)) {
      throw new Error(`[EventBus] Unregistered event name: ${String(eventName)}`)
    }
    return super.emit(eventName, ...args)
  }

  /**
   * @param {string} eventName
   * @param {(...args: unknown[]) => void} listener
   * @returns {this}
   */
  on (eventName, listener) {
    if (this._strict && !isRegisteredBusEvent(eventName)) {
      throw new Error(`[EventBus] Unregistered event name (on): ${String(eventName)}`)
    }
    return super.on(eventName, listener)
  }

  /**
   * @param {string} eventName
   * @param {(...args: unknown[]) => void} listener
   * @returns {this}
   */
  once (eventName, listener) {
    if (this._strict && !isRegisteredBusEvent(eventName)) {
      throw new Error(`[EventBus] Unregistered event name (once): ${String(eventName)}`)
    }
    return super.once(eventName, listener)
  }

  /**
   * @param {string} eventName
   * @param {(...args: unknown[]) => void} [listener]
   * @returns {this}
   */
  off (eventName, listener) {
    if (this._strict && !isRegisteredBusEvent(eventName)) {
      throw new Error(`[EventBus] Unregistered event name (off): ${String(eventName)}`)
    }
    return super.off(eventName, listener)
  }

  /** @returns {ReadonlySet<string>} */
  static get registeredNames () {
    const { REGISTERED_EVENT_NAMES } = require('./EventRegistry')
    return REGISTERED_EVENT_NAMES
  }
}

module.exports = { EventBus }
