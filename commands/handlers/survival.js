'use strict'

const { SurvivalEvents } = require('../../core/EventRegistry')
const { handledWithMessage } = require('../handlerResult')
const { COMMAND_LOG_CODES } = require('../commandLogCodes')

/** @param {any} ctx */
async function handleSurvivalOn (ctx, _parsed, _exec) {
  const at = Date.now()
  if (ctx.eventBus) ctx.eventBus.emit(SurvivalEvents.SET_SURVIVAL, { at })
  return handledWithMessage('Режим выживания включён.', { logCode: COMMAND_LOG_CODES.SURVIVAL_ON })
}

/** @param {any} ctx */
async function handleSurvivalOff (ctx, _parsed, _exec) {
  const at = Date.now()
  if (ctx.eventBus) ctx.eventBus.emit(SurvivalEvents.STOP_SURVIVAL, { at })
  return handledWithMessage('Режим выживания выключен.', { logCode: COMMAND_LOG_CODES.SURVIVAL_OFF })
}

const SURVIVAL_COMMAND_HANDLERS = {
  survival_on: handleSurvivalOn,
  survival_off: handleSurvivalOff
}

module.exports = { SURVIVAL_COMMAND_HANDLERS, handleSurvivalOn, handleSurvivalOff }
