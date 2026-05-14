'use strict'

const { Vec3 } = require('vec3')

/** Мин. смещение «якоря» цели (блоков), чтобы снова вызвать setGoal — см. Phase 4. */
const NAV_GOAL_MOVE_THRESH = 1.5

class CombatNavExecutor {
  constructor (bot) {
    this.bot = bot
    /** @type {Vec3 | null} */
    this._lastAnchor = null
  }

  _dist (a, b) {
    if (!a || !b) return Infinity
    const dx = a.x - b.x
    const dy = a.y - b.y
    const dz = a.z - b.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  clearGoal () {
    this._lastAnchor = null
    try {
      if (typeof this.bot.pathfinder?.setGoal === 'function') this.bot.pathfinder.setGoal(null)
    } catch (_) {}
  }

  /**
   * @param {import('mineflayer-pathfinder').Goal | null} goal
   * @param {boolean} dynamic
   * @param {{ x: number, y: number, z: number } | null} anchor — точка для дросселя (позиция цели или центр GoalNear)
   */
  setGoalThrottled (goal, dynamic, anchor) {
    const pf = this.bot.pathfinder
    if (!goal) {
      this.clearGoal()
      return
    }
    if (typeof pf?.setGoal !== 'function') return

    if (anchor && this._lastAnchor) {
      if (this._dist(anchor, this._lastAnchor) < NAV_GOAL_MOVE_THRESH) {
        return
      }
    }

    try {
      pf.setGoal(goal, dynamic)
      if (anchor) this._lastAnchor = new Vec3(anchor.x, anchor.y, anchor.z)
      else this._lastAnchor = null
    } catch (_) {}
  }
}

module.exports = { CombatNavExecutor, NAV_GOAL_MOVE_THRESH }
