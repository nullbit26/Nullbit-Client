'use strict'

const { goals } = require('mineflayer-pathfinder')
const { GoalFollow, GoalNear, GoalNearXZ } = goals
const { CFG, sleep } = require('./constants')
const {
  computeRangedLeadTicks,
  predictRangedAimPoint,
  bowDrawMsForDist,
  crossbowChargeMs
} = require('./geometry')
const { pickBestBow } = require('../../features/combatEquipment')
const { getCombatSessionActive } = require('./sessionFlags')
const { computeRangedCombat, isNarrowForRanged } = require('../policies/rangedCombatPolicy')

/**
 * Цель pathfinder для strategy 'archer': отход от ближней зоны, иначе держим дистанцию ~ARCHER_IDEAL_DIST.
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-entity').Entity} target
 */
function computeArcherGoal (bot, target) {
  const pos = bot.entity.position
  const tp = target.position
  const dist = pos.distanceTo(tp)

  if (dist < CFG.ARCHER_MIN_DIST) {
    const dx = pos.x - tp.x
    const dz = pos.z - tp.z
    const len = Math.hypot(dx, dz) || 1
    return new GoalNear(
      Math.floor(pos.x + (dx / len) * CFG.ARCHER_RETREAT_DIST),
      Math.floor(pos.y),
      Math.floor(pos.z + (dz / len) * CFG.ARCHER_RETREAT_DIST),
      2
    )
  }

  if (dist > 20) {
    return new GoalFollow(target, CFG.ARCHER_IDEAL_DIST)
  }

  return new GoalFollow(target, CFG.ARCHER_IDEAL_DIST)
}

/**
 * Цель pathfinder в режиме дальника: не под вертикаль цели, при убегании — фланг по XZ.
 */
function pickRangedMovementGoal (bot, target, dist, rc) {
  const b = bot.entity.position
  const t = target.position
  const dy = t.y - b.y
  const hDist = Math.hypot(t.x - b.x, t.z - b.z)

  if (dy > CFG.RANGED_TOWER_DY_MIN && hDist < CFG.RANGED_UNDER_MAX_HD) {
    let ox = b.x - t.x
    let oz = b.z - t.z
    const h = Math.hypot(ox, oz)
    if (h < 0.25) {
      ox = 1
      oz = 0
    } else {
      ox /= h
      oz /= h
    }
    const ring = CFG.RANGED_RING_DIST
    const gx = Math.floor(t.x + ox * ring)
    const gz = Math.floor(t.z + oz * ring)
    const gy = Math.floor(b.y)
    return new GoalNear(gx, gy, gz, 3)
  }

  if (rc.targetFleeing && dist > 5 && target.velocity) {
    const vx = target.velocity.x
    const vz = target.velocity.z
    const vh = Math.hypot(vx, vz)
    if (vh > CFG.RANGED_FLEE_FLANK_HD) {
      const ux = vx / vh
      const uz = vz / vh
      const px = -uz
      const pz = ux
      const side = CFG.RANGED_FLANK_SIDE
      const gx = Math.floor(t.x + px * side)
      const gz = Math.floor(t.z + pz * side)
      return new GoalNearXZ(gx, gz, CFG.RANGED_FLANK_NEAR_RANGE)
    }
    return new GoalFollow(target, Math.min(11, Math.max(6, dist * 0.55)))
  }

  return new GoalFollow(target, CFG.RANGED_GOAL_FOLLOW_DIST)
}

/** Сразу гасим pathfinder и клавиши — иначе прыжок/спринт/стрейф ломают прицел дальника. */
function clearMovementForRangedVolley (bot) {
  try {
    if (typeof bot.pathfinder?.setGoal === 'function') bot.pathfinder.setGoal(null)
  } catch (_) {}
  for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
    try {
      bot.setControlState(k, false)
    } catch (_) {}
  }
}

async function stabilizeForRangedVolley (bot) {
  clearMovementForRangedVolley(bot)
  await sleep(CFG.RANGED_STABILIZE_MS)
}

/** Один цикл прицел + выстрел (лук/арбалет уже в руке). */
async function performRangedVolley (bot, target, dist, bow) {
  if (!getCombatSessionActive() || !bow) return
  await stabilizeForRangedVolley(bot)
  if (!getCombatSessionActive()) return
  const leadTicks = computeRangedLeadTicks(bot, target, dist, bow)
  let aim = predictRangedAimPoint(bot, target, leadTicks)
  if (bow.name === 'bow') {
    const arcCompensation = Math.max(0, (dist - 10) * 0.012)
    aim = aim.offset(0, arcCompensation, 0)
  }
  await bot.lookAt(aim, true)
  if (bow.name === 'crossbow') {
    bot.activateItem()
    await sleep(crossbowChargeMs(bow))
    bot.deactivateItem()
    aim = predictRangedAimPoint(bot, target, Math.max(CFG.RANGED_LEAD_MIN_FLIGHT_TICKS, leadTicks - 5))
    await bot.lookAt(aim, true)
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(4)
    else await sleep(90)
    if (!getCombatSessionActive()) return
    bot.activateItem()
    await sleep(60)
    bot.deactivateItem()
  } else {
    bot.activateItem()
    const chargeTime = bowDrawMsForDist(dist)
    await sleep(chargeTime)
    if (!getCombatSessionActive()) return
    aim = predictRangedAimPoint(bot, target, Math.max(CFG.RANGED_LEAD_MIN_FLIGHT_TICKS, leadTicks - 3))
    await bot.lookAt(aim, true)
    bot.deactivateItem()
  }
}

function minMsUntilNextRangedVolley (bot, dist) {
  const bow = pickBestBow(bot)
  if (!bow) return 2500
  if (bow.name === 'crossbow') {
    return crossbowChargeMs(bow) + CFG.RANGED_VOLLEY_PAD_CROSSBOW_MS
  }
  return bowDrawMsForDist(dist) + CFG.RANGED_VOLLEY_PAD_BOW_MS
}

module.exports = {
  isNarrowForRanged,
  computeRangedCombat,
  computeArcherGoal,
  pickRangedMovementGoal,
  clearMovementForRangedVolley,
  stabilizeForRangedVolley,
  performRangedVolley,
  minMsUntilNextRangedVolley
}
