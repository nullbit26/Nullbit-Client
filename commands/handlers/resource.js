'use strict'

const { ResourceEvents } = require('../../core/EventRegistry')
const { handledWithMessage } = require('../handlerResult')
const { COMMAND_LOG_CODES } = require('../commandLogCodes')

async function handleGatherStart (ctx, parsed, _exec) {
  const resource = parsed?.args?.resource || 'wood'
  const at = Date.now()

  // Parse optional amount: number or "N stack(s)" / "N стак(а/ов)"
  let amount = 0
  const rawAmount = parsed?.args?.amount
  if (rawAmount !== undefined && rawAmount !== null) {
    const str = String(rawAmount).toLowerCase().trim()
    const stackMatch = str.match(/^(\d+)\s*(stack|stacks|стак|стака|стаков)$/)
    if (stackMatch) {
      amount = parseInt(stackMatch[1]) * 64
    } else {
      const n = parseInt(str)
      if (!isNaN(n) && n > 0) amount = n
    }
  }

  if (ctx.eventBus) ctx.eventBus.emit(ResourceEvents.GATHER_START, { resource, amount, at })
  const amountStr = amount > 0 ? ` (цель: ${amount} шт.)` : ''
  return handledWithMessage(`Начинаю собирать ${resource}${amountStr}.`, { logCode: COMMAND_LOG_CODES.GATHER_START })
}

async function handleGatherStop (ctx, _parsed, _exec) {
  const at = Date.now()
  if (ctx.eventBus) ctx.eventBus.emit(ResourceEvents.GATHER_STOP, { at })
  return handledWithMessage('Прекращаю сбор ресурсов.', { logCode: COMMAND_LOG_CODES.GATHER_STOP })
}

const RESOURCE_COMMAND_HANDLERS = {
  gather_start: handleGatherStart,
  gather_stop: handleGatherStop
}

module.exports = { RESOURCE_COMMAND_HANDLERS, handleGatherStart, handleGatherStop }
