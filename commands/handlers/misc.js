'use strict'

const { handledWithMessage } = require('../handlerResult')
const { COMMAND_LOG_CODES } = require('../commandLogCodes')

/** @param {any} ctx */
async function handleCraftGear (ctx, _parsed, _exec) {
  ctx.craft.craftGear().catch((e) => {
    ctx.log('[craft] error:', e.message)
    ctx.safeChat('Craft failed: ' + e.message.slice(0, 80))
  })
  return handledWithMessage('Checking inventory and crafting...', { logCode: COMMAND_LOG_CODES.CRAFT_STARTED })
}

/** @param {any} ctx */
async function handlePathStatus (ctx, _parsed, _exec) {
  const front = ctx.features.getFrontBlock()
  const feet = ctx.features.getFeetBlock()
  return handledWithMessage(
    `mode=${ctx.state.mode}, stuck=${ctx.state.stuckCount}, front=${front?.chestBlock?.name || 'air'}, feet=${feet?.name || 'air'}`,
    { logCode: COMMAND_LOG_CODES.PATH_STATUS }
  )
}

/** @param {any} ctx */
async function handleHealSelf (ctx, _parsed, _exec) {
  try {
    const hpThreshold = Number(ctx.config?.combatFleeSafeHp) || 16
    const res = await ctx.features.trySelfHealFromInventory(hpThreshold)
    if (!res?.consumed) {
      return handledWithMessage('Нечем лечиться: нет еды/лечебных зелий в инвентаре.', {
        logCode: COMMAND_LOG_CODES.HEAL_NO_CONSUMABLES
      })
    }
    if (res.kind === 'potion') {
      return handledWithMessage('Лечусь зельем.', { logCode: COMMAND_LOG_CODES.HEAL_CONSUMED_POTION })
    }
    return handledWithMessage('Перекусываю, восстанавливаю здоровье.', { logCode: COMMAND_LOG_CODES.HEAL_CONSUMED_FOOD })
  } catch (e) {
    ctx.log('[heal_self] error:', e?.message || e)
    return handledWithMessage('Не получилось полечиться: ' + String(e?.message || e).slice(0, 80), {
      logCode: COMMAND_LOG_CODES.HEAL_FAILED
    })
  }
}

const MISC_COMMAND_HANDLERS = {
  craft_gear: handleCraftGear,
  path_status: handlePathStatus,
  heal_self: handleHealSelf
}

module.exports = {
  MISC_COMMAND_HANDLERS,
  handleCraftGear,
  handlePathStatus,
  handleHealSelf
}
