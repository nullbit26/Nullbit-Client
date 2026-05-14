'use strict'

const COMMAND_LOG_CODES = /** @type {const} */ ({
  OK: 'ok',
  TARGET_NOT_VISIBLE: 'target_not_visible',
  TARGET_NOT_FOUND: 'target_not_found',
  /** Сообщение «атакуй» / `attack` без указания цели. */
  ATTACK_TARGET_REQUIRED: 'attack_target_required',
  TARGET_AMBIGUOUS: 'target_ambiguous',
  FRIENDLY_TARGET: 'friendly_target',
  DEFEND_ACTIVE: 'defend_active',
  // Успешная атака после явного override: снята охрана (defend) и выдан engage.
  ATTACK_DEFEND_OVERRIDE: 'attack_defend_override',
  COMBAT_BUSY: 'combat_busy',
  HANDLER_MISSING: 'handler_missing',
  DISPATCH_ERROR: 'dispatch_error',
  NOT_HANDLED: 'not_handled',
  POLICY_REJECTED: 'policy_rejected',
  COMBAT_INTERRUPT_FAILED: 'combat_interrupt_failed',
  TARGET_RESOLUTION_FAILED: 'target_resolution_failed',
  DEFEND_MISSING: 'defend_missing',
  DEFEND_POINT_MISSING: 'defend_point_missing',
  DEFEND_ERROR: 'defend_error',
  DEFEND_POINT_ERROR: 'defend_point_error',
  DEFEND_CANCELLED: 'defend_cancelled',
  NO_POSITION: 'no_position',
  QUOTED_PLAYER_REQUIRED: 'quoted_player_required',
  INVENTORY_SUMMARY: 'inventory_summary',
  INVENTORY_DUMP: 'inventory_dump',
  INVENTORY_DROP_ITEM_DONE: 'inventory_drop_item_done',
  INVENTORY_DROP_ITEM_NOT_FOUND: 'inventory_drop_item_not_found',
  INVENTORY_DROP_ITEM_FAILED: 'inventory_drop_item_failed',
  COME_SET: 'come_set',
  FOLLOW_SET: 'follow_set',
  GUARD_SET: 'guard_set',
  IDLE_SET: 'idle_set',
  CRAFT_STARTED: 'craft_started',
  PATH_STATUS: 'path_status',
  HEAL_NO_CONSUMABLES: 'heal_no_consumables',
  HEAL_CONSUMED_FOOD: 'heal_consumed_food',
  HEAL_CONSUMED_POTION: 'heal_consumed_potion',
  HEAL_FAILED: 'heal_failed',
  PARTY_HANDLER_MISSING: 'party_handler_missing',
  SURVIVAL_ON: 'survival_on',
  SURVIVAL_OFF: 'survival_off',
  NO_PARSED_COMMAND: 'no_parsed_command'
})

module.exports = { COMMAND_LOG_CODES }
