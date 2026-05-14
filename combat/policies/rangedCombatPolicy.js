'use strict'

const { CFG } = require('../session/constants')
const { pickBestBow } = require('../../features/combatEquipment')

/** Узкий проход / «коридор» — дальний бой хуже (лучше ближний). */
function isNarrowForRanged (bot) {
  if (!bot.entity?.position) return false
  const pos = bot.entity.position.floored()
  let walls = 0
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ]) {
    const b = bot.blockAt(pos.offset(dx, 1, dz))
    if (b && b.boundingBox === 'block') walls++
  }
  return walls >= 3
}

/** Единая логика: когда выгоден лук (открытое место vs коридор, дистанция, убегание). */
function computeRangedCombat (bot, dist, target) {
  const bow = pickBestBow(bot)
  const arrows = bot.inventory.items().find(
    (i) => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow'
  )
  const hasRanged = !!(bow && arrows)
  let targetFleeing = false
  if (target?.velocity && target.velocity.norm() > 0.1) {
    const toTarget = target.position.minus(bot.entity.position).unit()
    const velUnit = target.velocity.unit()
    targetFleeing = toTarget.dot(velUnit) > 0.5
  }
  const narrow = isNarrowForRanged(bot)
  let wantRanged = false
  if (hasRanged) {
    if (dist <= CFG.RANGED_MELEE_ONLY_MAX_DIST) {
      wantRanged = false
    } else if (narrow) {
      wantRanged = dist > 14 || (targetFleeing && dist > CFG.RANGED_FLEE_MIN_DIST)
    } else {
      wantRanged = dist > 8 || (targetFleeing && dist > CFG.RANGED_FLEE_MIN_DIST)
    }
  }
  return { wantRanged, hasRanged, bow, narrow, targetFleeing }
}

module.exports = { isNarrowForRanged, computeRangedCombat }
