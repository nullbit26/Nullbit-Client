'use strict'

const { pickNearestHostile, listHostilesWithin } = require('../systems/AwarenessSystem')

/**
 * @deprecated Awareness is wired through `BotBrain` + `AwarenessSystem` (see `index.js`).
 * @param {import('mineflayer').Bot} bot
 * @param {object} deps
 * @returns {{ start: () => void, stop: () => void }}
 */
function attachAwareness (bot, deps) {
  const log = deps?.log || ((...a) => console.log(...a))
  log('[awareness] attachAwareness is deprecated — use BotBrain with awarenessDeps')
  return { start () {}, stop () {} }
}

module.exports = { attachAwareness, pickNearestHostile, listHostilesWithin }
