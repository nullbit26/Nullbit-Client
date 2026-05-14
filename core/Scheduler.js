'use strict'

const { randomBytes } = require('crypto')
const { CoreEvents } = require('./EventRegistry')
const { coreLogger } = require('../utils/Logger')

/**
 * Tick-aligned scheduling using **only** Mineflayer `physicsTick`.
 * No `setInterval` / `setTimeout` for periodic work (timeouts for one-shot are still avoided here).
 *
 * @typedef {Object} SchedulerTask
 * @property {string} id
 * @property {number} intervalTicks - >= 1
 * @property {(args: { tickIndex: number }) => void} callback
 * @property {number} phase - offset 0..intervalTicks-1 so tasks can stagger
 */

class Scheduler {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ eventBus?: import('./EventBus').EventBus, logger?: import('../utils/Logger').Logger }} [opts]
   */
  constructor (bot, opts = {}) {
    if (!bot || typeof bot.on !== 'function') {
      throw new Error('[Scheduler] bot with .on is required')
    }
    /** @private */
    this._bot = bot
    /** @private @type {import('./EventBus').EventBus | null} */
    this._bus = opts.eventBus || null
    /** @private @type {import('../utils/Logger').Logger} */
    this._log = opts.logger || coreLogger
    /** @private @type {SchedulerTask[]} */
    this._tasks = []
    /** @private Monotonic counter incremented each physicsTick */
    this._tickIndex = 0
    /** @private */
    this._onPhysicsTick = this._onPhysicsTick.bind(this)
    bot.on('physicsTick', this._onPhysicsTick)
  }

  /** @private */
  _onPhysicsTick () {
    const tick = this._tickIndex++
    for (let i = 0; i < this._tasks.length; i++) {
      const t = this._tasks[i]
      if (((tick + t.phase) % t.intervalTicks) === 0) {
        try {
          t.callback({ tickIndex: tick })
        } catch (err) {
          this._log.error('task callback failed', JSON.stringify({ id: t.id, error: err instanceof Error ? err.message : String(err) }))
        }
      }
    }
  }

  /**
   * Run `callback` every `intervalTicks` physics ticks (interval >= 1).
   * @param {number} intervalTicks
   * @param {(args: { tickIndex: number }) => void} callback
   * @param {{ id?: string, phase?: number }} [options]
   * @returns {string} taskId
   */
  registerPeriodic (intervalTicks, callback, options = {}) {
    const n = Math.floor(Number(intervalTicks))
    if (!Number.isFinite(n) || n < 1) {
      throw new Error('[Scheduler] intervalTicks must be a finite integer >= 1')
    }
    if (typeof callback !== 'function') {
      throw new Error('[Scheduler] callback must be a function')
    }
    const id = options.id || `task_${randomBytes(6).toString('hex')}`
    let phase = options.phase == null ? 0 : Math.floor(Number(options.phase))
    if (!Number.isFinite(phase)) phase = 0
    phase = ((phase % n) + n) % n

    if (this._tasks.some((t) => t.id === id)) {
      throw new Error(`[Scheduler] duplicate task id: ${id}`)
    }

    this._tasks.push({ id, intervalTicks: n, callback, phase })

    if (this._bus) {
      this._bus.emit(CoreEvents.SCHEDULER_TASK_REGISTERED, { taskId: id, intervalTicks: n })
    }
    return id
  }

  /**
   * @param {string} taskId
   * @returns {boolean} whether a task was removed
   */
  unregister (taskId) {
    const before = this._tasks.length
    this._tasks = this._tasks.filter((t) => t.id !== taskId)
    const removed = this._tasks.length < before
    if (removed && this._bus) {
      this._bus.emit(CoreEvents.SCHEDULER_TASK_REMOVED, { taskId })
    }
    return removed
  }

  /** Remove listener; call when bot disconnects or brain shuts down. */
  destroy () {
    this._bot.removeListener('physicsTick', this._onPhysicsTick)
    this._tasks.length = 0
    this._bus = null
    this._log = coreLogger
  }
}

module.exports = { Scheduler }
