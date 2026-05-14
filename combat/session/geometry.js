'use strict'

const { CFG } = require('./constants')

function distanceTo (bot, entity) {
  return bot.entity.position.distanceTo(entity.position)
}

function predictPosition (entity, ticks = CFG.PREDICTION_TICKS) {
  if (!entity.velocity) return entity.position.clone()
  return entity.position.plus(entity.velocity.scaled(ticks))
}

function bowDrawMsForDist (dist) {
  if (dist > 30) return 1400
  if (dist > 20) return 1200
  if (dist > 12) return 1000
  return 800
}

/** Время натяжки арбалета (мс), как в mineflayer examples/crossbower.js */
function crossbowChargeMs (bow) {
  let qc = 0
  try {
    const list = bow?.nbt?.value?.Enchantments?.value?.value
    if (Array.isArray(list)) {
      const row = list.find(
        (e) =>
          e.id?.value === 'quick_charge' ||
          e.id?.value === 'minecraft:quick_charge'
      )
      if (row?.lvl?.value != null) qc = Math.min(3, Math.max(0, Number(row.lvl.value)))
    }
  } catch (_) {}
  return 1250 - qc * 250
}

/**
 * Сколько тиков вперёд экстраполировать цель для дальника.
 * velocity у сущности — примерно смещение за тик; учитываем полёт стрелы и время натяжки.
 */
function computeRangedLeadTicks (bot, target, dist, bow) {
  const drawMs = bow.name === 'crossbow' ? crossbowChargeMs(bow) : bowDrawMsForDist(dist)
  const bp = bot.entity.position
  const tp = target.position
  const horiz = Math.hypot(tp.x - bp.x, tp.z - bp.z) || Math.max(0.5, dist * 0.92)
  const bpt =
    bow.name === 'crossbow'
      ? CFG.RANGED_ARROW_SPEED_BPT_CROSSBOW
      : CFG.RANGED_ARROW_SPEED_BPT_BOW
  let flightTicks = Math.ceil(horiz / bpt) + 2
  flightTicks = Math.min(
    CFG.RANGED_LEAD_MAX_FLIGHT_TICKS,
    Math.max(CFG.RANGED_LEAD_MIN_FLIGHT_TICKS, flightTicks)
  )
  const windupTicks = Math.ceil(drawMs / 50)
  const frac =
    bow.name === 'crossbow'
      ? CFG.RANGED_LEAD_WINDUP_FRACTION_CROSSBOW
      : CFG.RANGED_LEAD_WINDUP_FRACTION_BOW
  return Math.min(48, flightTicks + Math.floor(windupTicks * frac))
}

function predictRangedAimPoint (bot, target, leadTicks) {
  const aimBase = predictPosition(target, leadTicks)
  const h = target.height ?? 1.8
  return aimBase.offset(0, h * 0.88, 0)
}

module.exports = {
  distanceTo,
  predictPosition,
  bowDrawMsForDist,
  crossbowChargeMs,
  computeRangedLeadTicks,
  predictRangedAimPoint
}
