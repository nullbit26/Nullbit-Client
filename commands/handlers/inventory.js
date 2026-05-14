'use strict'

const { handledWithMessage } = require('../handlerResult')
const { COMMAND_LOG_CODES } = require('../commandLogCodes')
const { DELIVERY_CHANNELS } = require('../deliveryPolicy')

/** @param {any} ctx */
async function handleInv (ctx, _parsed, { username }) {
  const summary = ctx.features.buildInventorySummary()
  const out = summary.length > 360 ? summary.slice(0, 357) + '...' : summary
  return handledWithMessage(out, { channel: DELIVERY_CHANNELS.WHISPER_PREFERRED, logCode: COMMAND_LOG_CODES.INVENTORY_SUMMARY })
}

/** @param {any} ctx */
async function handleDump (ctx, _parsed, _exec) {
  await ctx.features.dumpUnwantedItems()
  return handledWithMessage('Dropped unnecessary items / Выбросил лишнее.', { logCode: COMMAND_LOG_CODES.INVENTORY_DUMP })
}

/** @param {any} ctx */
async function handleDropItemQty (ctx, parsed, _exec) {
  const qty = Math.max(1, Math.floor(Number(parsed?.args?.quantity) || 0))
  const query = String(parsed?.args?.itemQuery || '').trim()
  if (!query || !Number.isFinite(qty) || qty <= 0) {
    return handledWithMessage('Формат: выброси <число> <название предмета>.', {
      logCode: COMMAND_LOG_CODES.INVENTORY_DROP_ITEM_FAILED
    })
  }
  const res = await ctx.features.tossItemByQuery(qty, query)
  if (!res?.ok) {
    return handledWithMessage(`Не нашёл предмет по запросу: ${query}.`, {
      logCode: COMMAND_LOG_CODES.INVENTORY_DROP_ITEM_NOT_FOUND
    })
  }
  return handledWithMessage(`Выбросил ${res.dropped} x ${res.itemName}.`, {
    logCode: COMMAND_LOG_CODES.INVENTORY_DROP_ITEM_DONE
  })
}

const INVENTORY_COMMAND_HANDLERS = {
  inv: handleInv,
  dump: handleDump,
  drop_item_qty: handleDropItemQty
}

module.exports = {
  INVENTORY_COMMAND_HANDLERS,
  handleInv,
  handleDump,
  handleDropItemQty
}
