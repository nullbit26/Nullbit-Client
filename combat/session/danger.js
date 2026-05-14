'use strict'

const { CFG } = require('./constants')
const { distanceTo } = require('./geometry')

function detectIncomingArrows (bot) {
  return Object.values(bot.entities).filter((e) => {
    if (e.name !== 'arrow') return false
    if (distanceTo(bot, e) > CFG.ARROW_DODGE_DIST) return false
    if (!e.velocity) return false
    const toBot = bot.entity.position.minus(e.position).normalize()
    const velNorm = e.velocity.normalize()
    return toBot.dot(velNorm) > 0.7
  })
}

function isInDanger (bot) {
  const pos = bot.entity.position
  const dangerBlocks = [
    'lava',
    'flowing_lava',
    'fire',
    'soul_fire',
    'magma_block',
    'campfire',
    'soul_campfire',
    'cactus',
    'sweet_berry_bush',
    'wither_rose',
    'tripwire',
    'tripwire_hook',
    'tnt',
    'powder_snow',
    'cobweb'
  ]

  const underFeet = bot.blockAt(bot.entity.position.offset(0, 0, 0))
  const atFeet = bot.blockAt(bot.entity.position.offset(0, 1, 0))
  if (
    (underFeet?.name && underFeet.name.includes('tripwire')) ||
    (atFeet?.name && atFeet.name.includes('tripwire'))
  ) {
    return 'tripwire'
  }

  if (bot.entity.isInLava) return 'lava'

  const lavaNames = ['lava', 'flowing_lava']
  for (const offset of [
    [0, 0, 0],
    [0, -1, 0], // под ногами
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1] // вплотную по сторонам
  ]) {
    const b = bot.blockAt(pos.offset(offset[0], offset[1], offset[2]))
    if (b && lavaNames.some((n) => b.name.includes(n))) return 'lava'
  }

  for (const offset of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, -1, 0]
  ]) {
    const b = bot.blockAt(pos.offset(offset[0], offset[1], offset[2]))
    if (b && dangerBlocks.some((d) => b.name.includes(d))) return 'near_danger'
  }

  if (bot.entity.isInWater && bot.health < 10) return 'water'

  return false
}

module.exports = { isInDanger, detectIncomingArrows }
