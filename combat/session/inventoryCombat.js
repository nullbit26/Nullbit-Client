'use strict'

const { CFG } = require('./constants')
const { computeRangedCombat } = require('../policies/rangedCombatPolicy')
const { performRangedVolley } = require('./rangedPolicy')
const { WEAPON_PRIORITY, equipBestWeapon } = require('../../features/combatEquipment')

function isHeldMeleeWeapon (held) {
  return !!(held && WEAPON_PRIORITY.some((w) => held.name.includes(w.key)))
}

function isHeldRangedWeapon (held) {
  return !!(held && (held.name === 'bow' || held.name === 'crossbow'))
}

async function equipByDistance (bot, dist, target, opts = {}) {
  const forceRanged = !!opts.forceRanged
  let { wantRanged, hasRanged, bow, narrow, targetFleeing } = computeRangedCombat(bot, dist, target)
  if (forceRanged && hasRanged) wantRanged = true

  if (hasRanged && wantRanged) {
    const held = bot.heldItem
    if (!held || held.name !== bow.name) {
      await bot.equip(bow, 'hand')
      console.log(
        `[PVP] Дальний бой (${bow.name}, dist: ${dist.toFixed(1)}, узко: ${narrow}, убегает: ${targetFleeing})`
      )
    }

    if (!(forceRanged && dist < CFG.ARCHER_MIN_DIST)) {
      await performRangedVolley(bot, target, dist, bow)
    }
    return 'ranged'
  }

  const held = bot.heldItem
  if (!isHeldMeleeWeapon(held)) await equipBestWeapon(bot)
  return 'melee'
}

module.exports = { isHeldMeleeWeapon, isHeldRangedWeapon, equipByDistance }
