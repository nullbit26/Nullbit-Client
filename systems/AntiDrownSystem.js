'use strict'

const DROWN_AIR_THRESHOLD = 10   // start surfacing when air < 10 (max 20)
const TICK_INTERVAL       = 2    // check every 2 physics ticks
const TASK_ID             = 'anti_drown_tick'

/**
 * AntiDrownSystem
 *
 * Monitors bot air supply every 2 ticks.
 * When air < DROWN_AIR_THRESHOLD and bot is submerged:
 *   - Stops current pathfinder goal
 *   - Holds jump to swim upward until at surface or air restored
 */
class AntiDrownSystem {
  constructor ({ bot, brain }) {
    this._bot = bot
    this._brain = brain
    this._wired = false
    this._surfacing = false
    this._tick = this._tick.bind(this)
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._brain.scheduler.registerPeriodic(TICK_INTERVAL, this._tick, { id: TASK_ID, phase: 1 })
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    try { this._brain.scheduler.unregister(TASK_ID) } catch (_) {}
    this._stopSurfacing()
  }

  /** @private */
  _tick () {
    try {
      const bot = this._bot
      const air = bot.oxygenLevel ?? bot.entity?.metadata?.[1] ?? 20

      const inWater = bot.entity?.isInWater ?? false
      const isSubmerged = inWater && (bot.entity?.position?.y % 1 < 0.9)

      if (isSubmerged && air < DROWN_AIR_THRESHOLD) {
        if (!this._surfacing) {
          this._startSurfacing()
        }
      } else if (this._surfacing && (!inWater || air >= 18)) {
        this._stopSurfacing()
      }
    } catch (_) {}
  }

  /** @private */
  _startSurfacing () {
    this._surfacing = true
    try { this._brain.log.warn('[AntiDrown] Low air — surfacing') } catch (_) {}
    try {
      this._bot.pathfinder.setGoal(null)
    } catch (_) {}
    // Hold jump every tick to swim up
    this._surfaceInterval = setInterval(() => {
      try {
        if (!this._surfacing) { clearInterval(this._surfaceInterval); return }
        this._bot.setControlState('jump', true)
        setTimeout(() => {
          try { this._bot.setControlState('jump', false) } catch (_) {}
        }, 200)
      } catch (_) {}
    }, 300)
  }

  /** @private */
  _stopSurfacing () {
    this._surfacing = false
    try { clearInterval(this._surfaceInterval) } catch (_) {}
    try { this._bot.setControlState('jump', false) } catch (_) {}
    try { this._brain.log.info('[AntiDrown] Air restored') } catch (_) {}
  }
}

module.exports = { AntiDrownSystem }
