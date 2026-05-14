'use strict'

const { findBestHealPotion, isSplashLikePotion } = require('../utils/combatConsumables')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const FOOD_DENYLIST = new Set(['spider_eye', 'poisonous_potato', 'pufferfish', 'rotten_flesh'])

/**
 * @param {import('mineflayer').Bot} bot
 */
function findBestFoodItem (bot) {
  const byName = bot.registry?.foodsByName
  if (!byName || typeof bot.inventory?.items !== 'function') return null
  let best = null
  let bestQ = -1
  for (const item of bot.inventory.items()) {
    if (!item?.name || FOOD_DENYLIST.has(item.name)) continue
    const fd = byName[item.name]
    if (!fd) continue
    const q = Number(fd.effectiveQuality ?? fd.foodPoints ?? 0)
    if (q > bestQ) {
      bestQ = q
      best = item
    }
  }
  return best
}

/**
 * @param {import('mineflayer').Bot} bot
 */
async function consumeFood (bot, item) {
  await bot.equip(item, 'hand')
  await sleep(120)
  await Promise.race([
    bot.consume(),
    sleep(5000).then(() => Promise.reject(new Error('consume_timeout')))
  ])
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {number} hpThreshold
 * @returns {Promise<{ ok: boolean, consumed: boolean, kind?: 'food'|'potion', reason?: string }>}
 */
async function trySelfHealFromInventory (bot, hpThreshold = 16) {
  const potion = findBestHealPotion(bot, hpThreshold)
  const food = findBestFoodItem(bot)
  if (!potion && !food) return { ok: true, consumed: false, reason: 'no_consumables' }

  const hp = Number(bot.health)
  const foodLevel = Number(bot.food)
  const shouldUsePotion = !!potion && (
    !food ||
    !Number.isFinite(foodLevel) ||
    foodLevel >= 20 ||
    (Number.isFinite(hp) && hp < 14)
  )

  if (shouldUsePotion) {
    await bot.equip(potion, 'hand')
    await sleep(120)
    if (isSplashLikePotion(potion)) {
      try { await bot.look(-Math.PI / 2, 0, true) } catch (_) {}
      try {
        bot.activateItem()
        await sleep(420)
      } finally {
        try { bot.deactivateItem() } catch (_) {}
      }
    } else {
      await Promise.race([
        bot.consume(),
        sleep(5000).then(() => Promise.reject(new Error('potion_consume_timeout')))
      ])
    }
    return { ok: true, consumed: true, kind: 'potion' }
  }

  if (food) {
    await consumeFood(bot, food)
    return { ok: true, consumed: true, kind: 'food' }
  }
  return { ok: true, consumed: false, reason: 'no_usable_choice' }
}

module.exports = { trySelfHealFromInventory }
