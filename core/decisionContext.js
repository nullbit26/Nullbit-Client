'use strict'

const { isCombatSessionActive } = require('../attackEntity')
const { evaluateThreatPressure } = require('../combat/flee/evaluateThreatPressure')
const {
  getInventoryFillRatio,
  getInventoryValueScore,
  getFreeSlots,
  hasAnyFood,
  hasHealing
} = require('../utils/inventoryValue')

/**
 * Immutable world snapshot consumed by all decision/utility systems.
 * Build once per decision tick; pass by reference — do NOT mutate.
 *
 * @typedef {Object} DecisionContext
 * @property {number}  now
 * @property {string}  coreState
 * @property {boolean} combatSessionActive
 * @property {number}  hp
 * @property {number}  food
 * @property {number}  maxHealth
 * @property {number}  threatPressure           - combinedPressure from evaluateThreatPressure
 * @property {number}  retreatScore
 * @property {boolean} immediateDanger
 * @property {boolean} recentAggroPressure
 * @property {boolean} safeToRecover
 * @property {boolean} safeToExitFlee
 * @property {boolean} healWindowSafe
 * @property {number|null} nearestThreatDistance
 * @property {boolean} hasFood
 * @property {boolean} hasHealing
 * @property {number}  inventoryFillRatio        - 0..1
 * @property {number}  inventoryValueScore       - 0..1
 * @property {number}  freeSlots
 * @property {Object|null} currentTask
 * @property {Object|null} interruptedTask
 * @property {boolean} survivalActive
 * @property {boolean} recoveryHoldActive
 */

/**
 * Build an immutable {@link DecisionContext} for the current tick.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('./BotBrain').BotBrain} brain
 * @param {any} config
 * @param {number} [now]
 * @returns {Readonly<DecisionContext>}
 */
function buildDecisionContext (bot, brain, config, now) {
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const memory = brain.memory
  const pressure = evaluateThreatPressure(bot, memory, config, t)

  const threats = memory.getCurrentThreats()
  let nearestThreatDistance = null
  for (const th of threats) {
    const d = Number(th.distance)
    if (Number.isFinite(d) && (nearestThreatDistance === null || d < nearestThreatDistance)) {
      nearestThreatDistance = d
    }
  }

  const taskState = brain.taskState || null

  return Object.freeze({
    now: t,

    coreState: brain.state.getState(),
    combatSessionActive: isCombatSessionActive(),

    hp: Number(bot.health) || 0,
    food: Number(bot.food) || 0,
    maxHealth: Number(bot.maxHealth) || 20,

    threatPressure: pressure.combinedPressure,
    retreatScore: pressure.retreatScore,
    immediateDanger: pressure.immediateDanger,
    recentAggroPressure: pressure.recentAggroPressure,
    safeToRecover: pressure.safeToRecover,
    safeToExitFlee: pressure.safeToExitFlee,
    healWindowSafe: pressure.healWindowSafe,
    nearestThreatDistance,

    hasFood: hasAnyFood(bot),
    hasHealing: hasHealing(bot),
    inventoryFillRatio: getInventoryFillRatio(bot),
    inventoryValueScore: getInventoryValueScore(bot),
    freeSlots: getFreeSlots(bot),

    currentTask: taskState ? taskState.currentTask : null,
    interruptedTask: taskState ? taskState.interruptedTask : null,

    survivalActive: brain.survivalSystem ? brain.survivalSystem.isActive() : false,
    recoveryHoldActive: brain.recoveryHoldSystem ? brain.recoveryHoldSystem.isActive() : false
  })
}

module.exports = { buildDecisionContext }
