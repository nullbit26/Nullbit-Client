'use strict'

const { MovementEvents, CombatEvents, SurvivalEvents } = require('../../core/EventRegistry')
const { handledWithMessage } = require('../handlerResult')
const { COMMAND_LOG_CODES } = require('../commandLogCodes')

/** @param {any} ctx @param {any} _parsed @param {{ username: string, target: any }} x */
async function handleCome (ctx, _parsed, { username, target }) {
  if (!target.entity) return handledWithMessage('Я тебя не вижу!', { logCode: COMMAND_LOG_CODES.TARGET_NOT_VISIBLE })
  const at = Date.now()
  if (ctx.eventBus) ctx.eventBus.emit(MovementEvents.SET_COME, { targetUsername: username, at })
  else ctx.movementActions.setModeCome(username)
  return handledWithMessage('Бегу!', { logCode: COMMAND_LOG_CODES.COME_SET })
}

/**
 * @param {any} ctx
 */
async function handleFollow (ctx, _parsed, { username, target }) {
  if (!target.entity) return handledWithMessage('Я тебя не вижу!', { logCode: COMMAND_LOG_CODES.TARGET_NOT_VISIBLE })
  const at = Date.now()
  if (ctx.eventBus) ctx.eventBus.emit(MovementEvents.SET_FOLLOW, { targetUsername: username, at })
  else ctx.movementActions.setModeFollow(username)
  return handledWithMessage('Окей, следую за тобой.', { logCode: COMMAND_LOG_CODES.FOLLOW_SET })
}

/**
 * @param {any} ctx
 */
async function handleGuard (ctx, _parsed, { username, target }) {
  if (!target.entity) return handledWithMessage('Подойди поближе!', { logCode: COMMAND_LOG_CODES.TARGET_NOT_VISIBLE })
  const at = Date.now()
  if (ctx.eventBus) ctx.eventBus.emit(CombatEvents.SET_GUARD, { targetUsername: username, at })
  else ctx.combatActions.setModeGuard(username)
  return handledWithMessage('Режим телохранителя включен.', { logCode: COMMAND_LOG_CODES.GUARD_SET })
}

/**
 * @param {any} ctx
 */
async function handleStop (ctx, _parsed, _exec) {
  // Stop should cancel active defend loops too (defendEntity/point/patrol),
  // otherwise they can continue publishing follow-like goals after SET_IDLE.
  if (ctx.defend && typeof ctx.defend.stopAllDefend === 'function') {
    try { ctx.defend.stopAllDefend({ silent: true }) } catch (_) {}
  }
  const at = Date.now()
  if (ctx.eventBus) ctx.eventBus.emit(SurvivalEvents.STOP_SURVIVAL, { at })
  if (ctx.eventBus) ctx.eventBus.emit(MovementEvents.SET_IDLE, { at })
  else ctx.movementActions.setModeIdle()
  return handledWithMessage('Остановился.', { logCode: COMMAND_LOG_CODES.IDLE_SET })
}

const MOVEMENT_COMMAND_HANDLERS = {
  come: handleCome,
  follow: handleFollow,
  guard: handleGuard,
  stop: handleStop
}

module.exports = {
  MOVEMENT_COMMAND_HANDLERS,
  handleCome,
  handleFollow,
  handleGuard,
  handleStop
}
