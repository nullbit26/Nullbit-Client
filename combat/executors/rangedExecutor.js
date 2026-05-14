'use strict'

const {
  clearMovementForRangedVolley,
  performRangedVolley
} = require('../session/rangedPolicy')

function clearForVolley (bot) {
  clearMovementForRangedVolley(bot)
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {object} target
 * @param {number} dist
 * @param {object} bow
 */
async function performVolley (bot, target, dist, bow) {
  return performRangedVolley(bot, target, dist, bow)
}

module.exports = { clearForVolley, performVolley }
