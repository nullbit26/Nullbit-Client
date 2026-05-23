'use strict'

const { goals: { GoalNear } } = require('mineflayer-pathfinder')

const RECOVERY_TIMEOUT_MS = 30000  // give up after 30s
const ITEM_COLLECT_RADIUS = 2      // blocks from drop to consider collected
const RESPAWN_DELAY_MS    = 2000   // wait after spawn before running to drop

/**
 * RespawnRecoverySystem
 *
 * On death: records position.
 * On next spawn: navigates back to death point to collect dropped items.
 * Gives up after RECOVERY_TIMEOUT_MS or if bot enters COMBAT/FLEE.
 */
class RespawnRecoverySystem {
  constructor ({ bot, brain }) {
    this._bot = bot
    this._brain = brain
    this._wired = false
    this._deathPos = null
    this._recovering = false
    this._onDeath = this._onDeath.bind(this)
    this._onSpawn = this._onSpawn.bind(this)
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bot.on('death', this._onDeath)
    this._bot.on('spawn', this._onSpawn)
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._bot.off('death', this._onDeath)
    this._bot.off('spawn', this._onSpawn)
    this._recovering = false
  }

  /** @private */
  _onDeath () {
    try {
      const pos = this._bot.entity?.position
      if (pos) {
        this._deathPos = pos.clone()
        try { this._brain.log.info(`[RespawnRecovery] Death at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`) } catch (_) {}
      }
    } catch (_) {}
  }

  /** @private */
  _onSpawn () {
    if (!this._deathPos || this._recovering) return
    setTimeout(() => this._recover(), RESPAWN_DELAY_MS)
  }

  /** @private */
  async _recover () {
    if (!this._deathPos || this._recovering) return
    const target = this._deathPos
    this._deathPos = null
    this._recovering = true

    try {
      const state = this._brain?.state?.getState?.()
      if (state === 'COMBAT' || state === 'FLEE') {
        this._recovering = false
        return
      }

      try { this._brain.log.info(`[RespawnRecovery] Heading to death point`) } catch (_) {}

      const goal = new GoalNear(target.x, target.y, target.z, ITEM_COLLECT_RADIUS)
      this._bot.pathfinder.setGoal(goal)

      const deadline = Date.now() + RECOVERY_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500))
        const coreState = this._brain?.state?.getState?.()
        if (coreState === 'COMBAT' || coreState === 'FLEE') break

        const pos = this._bot.entity?.position
        if (pos && pos.distanceTo(target) <= ITEM_COLLECT_RADIUS + 1) break
      }

      this._bot.pathfinder.setGoal(null)
      try { this._brain.log.info(`[RespawnRecovery] Done`) } catch (_) {}
    } catch (e) {
      try { this._brain.log.warn(`[RespawnRecovery] Error: ${e.message}`) } catch (_) {}
    } finally {
      this._recovering = false
    }
  }
}

module.exports = { RespawnRecoverySystem }
