'use strict'

const { handledWithMessage } = require('../handlerResult')
const { COMMAND_LOG_CODES } = require('../commandLogCodes')

/** @param {any} ctx @param {import('../parsePlayerMessage').ParsedPlayerMessage} parsed */
async function handleDefendEntity (ctx, parsed, { username, target }) {
  if (!ctx.defend || typeof ctx.defend.defendEntity !== 'function') {
    return handledWithMessage('Охрана не подключена.', { logCode: COMMAND_LOG_CODES.DEFEND_MISSING })
  }
  if (parsed.targetMode === 'sender') {
    if (!target.entity) return handledWithMessage('Я тебя не вижу!', { logCode: COMMAND_LOG_CODES.TARGET_NOT_VISIBLE })
    try {
      await ctx.defend.defendEntity({ player_name: username })
    } catch (e) {
      ctx.log('[defend entity]', e?.message || e)
      return handledWithMessage('Режим охраны сбой: ' + String(e?.message || e).slice(0, 100), { logCode: COMMAND_LOG_CODES.DEFEND_ERROR })
    }
    return handledWithMessage('Охраняю тебя: рядом и от угроз.', { logCode: COMMAND_LOG_CODES.OK })
  }
  const nick = target.username
  if (!nick) return handledWithMessage('Укажи ник в кавычках.', { logCode: COMMAND_LOG_CODES.QUOTED_PLAYER_REQUIRED })
  try {
    await ctx.defend.defendEntity({ player_name: nick })
  } catch (e) {
    ctx.log('[defend entity]', e?.message || e)
    return handledWithMessage('Режим охраны сбой: ' + String(e?.message || e).slice(0, 100), { logCode: COMMAND_LOG_CODES.DEFEND_ERROR })
  }
  return handledWithMessage(`Охраняю ${nick}.`, { logCode: COMMAND_LOG_CODES.OK })
}

/** @param {any} ctx */
async function handleDefendPoint (ctx, _parsed, _exec) {
  if (!ctx.defend || typeof ctx.defend.defendPoint !== 'function') {
    return handledWithMessage('Охрана точки не подключена.', { logCode: COMMAND_LOG_CODES.DEFEND_POINT_MISSING })
  }
  if (!ctx.bot.entity?.position) return handledWithMessage('Нет позиции.', { logCode: COMMAND_LOG_CODES.NO_POSITION })
  try {
    await ctx.defend.defendPoint({})
  } catch (e) {
    ctx.log('[defend point]', e?.message || e)
    return handledWithMessage('Охрана точки: ' + String(e?.message || e).slice(0, 100), { logCode: COMMAND_LOG_CODES.DEFEND_POINT_ERROR })
  }
  return handledWithMessage('Стою на точке и охраняю.', { logCode: COMMAND_LOG_CODES.OK })
}

/** @param {any} ctx */
async function handleCancelDefend (ctx, _parsed, _exec) {
  if (ctx.defend && typeof ctx.defend.stopAllDefend === 'function') {
    ctx.defend.stopAllDefend({ silent: true })
    return handledWithMessage('Защита отключена.', { logCode: COMMAND_LOG_CODES.DEFEND_CANCELLED })
  } else {
    return handledWithMessage('Защита не подключена.', { logCode: COMMAND_LOG_CODES.DEFEND_MISSING })
  }
}

const DEFEND_COMMAND_HANDLERS = {
  defend_entity: handleDefendEntity,
  defend_point: handleDefendPoint,
  cancel_defend: handleCancelDefend
}

module.exports = {
  DEFEND_COMMAND_HANDLERS,
  handleDefendEntity,
  handleDefendPoint,
  handleCancelDefend
}
