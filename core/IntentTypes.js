'use strict'

/**
 * Canonical intent `type` strings produced by {@link ../systems/AIIntentSystem} and consumed by {@link ./BotBrain}.
 * @readonly
 */
const IntentTypes = Object.freeze({
  /** defendStop + movement idle (Assistant tool `stop`). */
  BOT_STOP: 'BOT_STOP',
  /** defendStop only (Assistant tool `defendStop`). */
  DEFEND_STOP: 'DEFEND_STOP',
  MOVEMENT_SET_FOLLOW: 'MOVEMENT_SET_FOLLOW',
  MOVEMENT_SET_COME: 'MOVEMENT_SET_COME',
  COMBAT_SET_GUARD: 'COMBAT_SET_GUARD',
  NAV_GOTO: 'NAV_GOTO',
  GAMEPLAY_CRAFT_GEAR: 'GAMEPLAY_CRAFT_GEAR',
  GAMEPLAY_TOGGLE_FLIGHT: 'GAMEPLAY_TOGGLE_FLIGHT',
  COMBAT_ENGAGE_ENTITY: 'COMBAT_ENGAGE_ENTITY',
  COMBAT_STOP_ATTACK: 'COMBAT_STOP_ATTACK',
  DEFEND_PATROL: 'DEFEND_PATROL',
  DEFEND_POINT: 'DEFEND_POINT',
  DEFEND_ENTITY: 'DEFEND_ENTITY'
})

module.exports = { IntentTypes }
