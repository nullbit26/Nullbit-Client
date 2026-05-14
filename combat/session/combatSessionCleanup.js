'use strict'

/**
 * Full teardown of combat-owned control + pathfinder (Phase 2: includes `clearControlStates`).
 * @param {import('mineflayer').Bot} bot
 */
function combatSessionCleanup (bot) {
  try {
    if (typeof bot.clearControlStates === 'function') {
      bot.clearControlStates()
    } else {
      bot.setControlState('sprint', false)
      ;['jump', 'sneak', 'left', 'right', 'back', 'sprint'].forEach((s) => bot.setControlState(s, false))
    }
    bot.deactivateItem()
    bot.pathfinder?.setGoal(null)
  } catch (e) {
    console.error('[PVP] cleanup:', e.message)
  }
}

module.exports = { combatSessionCleanup }
