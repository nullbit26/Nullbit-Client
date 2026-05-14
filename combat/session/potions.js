'use strict'

const { CFG, sleep } = require('./constants')
const { findBestHealPotion, isSplashLikePotion } = require('../../utils/combatConsumables')
const { equipBestWeapon } = require('../../features/combatEquipment')

/** Внешний таймаут чуть выше mineflayer CONSUME_TIMEOUT (2.5s), чтобы успеть cleanup. */
const CONSUME_OUTER_MS = 3400
/** @type {WeakMap<any, number>} */
const BOT_POTION_LOCK_UNTIL = new WeakMap()

function prepBotForDrink (bot) {
  try {
    if (typeof bot.clearControlStates === 'function') bot.clearControlStates()
    else {
      bot.setControlState('sprint', false)
      for (const k of ['forward', 'back', 'left', 'right', 'jump']) {
        try {
          bot.setControlState(k, false)
        } catch (_) {}
      }
    }
  } catch (_) {}
  try {
    if (typeof bot.pathfinder?.setGoal === 'function') bot.pathfinder.setGoal(null)
  } catch (_) {}
}

function safeDeactivate (bot) {
  try {
    bot.deactivateItem()
  } catch (_) {}
}

function logDrinkPotionWarn (msg) {
  const now = Date.now()
  if (!logDrinkPotionWarn._last || now - logDrinkPotionWarn._last > 12000) {
    logDrinkPotionWarn._last = now
    console.warn('[PVP] drinkPotion:', msg)
  }
}

async function drinkPotion (bot) {
  const now = Date.now()
  const lockUntil = BOT_POTION_LOCK_UNTIL.get(bot) || 0
  if (lockUntil > now) return false
  BOT_POTION_LOCK_UNTIL.set(bot, now + CONSUME_OUTER_MS + 800)
  const thr = Math.max(CFG.RECOVER_EXIT_HEALTH, 14)
  const pot = findBestHealPotion(bot, thr)
  if (!pot) {
    BOT_POTION_LOCK_UNTIL.set(bot, Date.now() + 600)
    return false
  }
  try {
    await bot.equip(pot, 'hand')
    await sleep(120)
    if (isSplashLikePotion(pot)) {
      await bot.look(bot.entity.yaw, -1.55, true)
      bot.activateItem(false)
      await sleep(500)
      try {
        bot.deactivateItem()
      } catch (_) {}
    } else {
      prepBotForDrink(bot)
      try {
        await Promise.race([
          bot.consume(),
          sleep(CONSUME_OUTER_MS).then(() => Promise.reject(new Error('consume_stalled')))
        ])
      } catch (e) {
        safeDeactivate(bot)
        prepBotForDrink(bot)
        const m = String(e?.message || e)
        if (!m.includes('consume_stalled')) logDrinkPotionWarn(m)
        return false
      }
    }
    await equipBestWeapon(bot)
    console.log(`[PVP] Зелье: ${pot.name}`)
    BOT_POTION_LOCK_UNTIL.set(bot, Date.now() + 700)
    return true
  } catch (e) {
    safeDeactivate(bot)
    try {
      if (typeof bot.clearControlStates === 'function') bot.clearControlStates()
    } catch (_) {}
    logDrinkPotionWarn(String(e?.message || e))
    BOT_POTION_LOCK_UNTIL.set(bot, Date.now() + 1400)
    return false
  }
}

module.exports = { drinkPotion }
