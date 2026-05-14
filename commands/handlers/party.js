'use strict'

const { handledNoMessage, notHandled } = require('../handlerResult')
const { COMMAND_LOG_CODES } = require('../commandLogCodes')

/** @param {any} ctx */
function tryHandlePartyManage (ctx, _parsed, { username, raw }) {
  if (ctx.partyIFF?.tryHandleChatCommand?.(username, raw)) {
    return handledNoMessage()
  }
  ctx.log('[commands] party_manage not handled (PartyIFF missing?)')
  return notHandled(COMMAND_LOG_CODES.PARTY_HANDLER_MISSING)
}

module.exports = { tryHandlePartyManage }
