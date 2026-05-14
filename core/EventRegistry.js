'use strict'

/**
 * Strict registry of bus event names and payload shapes (JSDoc contracts).
 * Core + Navigation + Awareness names share one registry for `EventBus` strict mode.
 *
 * @fileoverview
 */

// ── Core payload typedefs ──

/**
 * @typedef {Object} CoreStateChangedPayload
 * @property {string} from
 * @property {string} to
 * @property {number} at
 * @property {Object} [meta]
 */

/**
 * @typedef {Object} CoreSchedulerTaskRegisteredPayload
 * @property {string} taskId
 * @property {number} intervalTicks
 */

/**
 * @typedef {Object} CoreSchedulerTaskRemovedPayload
 * @property {string} taskId
 */

/**
 * @typedef {Object} CoreBrainReadyPayload
 * @property {number} at
 */

/**
 * @typedef {Object} CoreBrainShutdownPayload
 * @property {number} at
 * @property {string} [reason]
 */

// ── Navigation ──

/**
 * Command: go to a world position (wrapper uses `GoalNear`).
 * @typedef {Object} NavGotoPayload
 * @property {'near'} kind
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} [range]
 */

/**
 * Command: stop current pathfinder goal.
 * @typedef {Object} NavStopPayload
 * @property {string} [reason]
 */

/**
 * Pathfinder reported end state for a think cycle.
 * @typedef {Object} NavPathResultPayload
 * @property {string} [status] - e.g. `success`, `noPath`, `timeout`, `partial`
 * @property {number} at
 * @property {string} [rawStatus] - same as status if present
 */

/**
 * High-level goal applied (or cleared).
 * @typedef {Object} NavGoalSetPayload
 * @property {'near'|'cleared'|string} kind
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [z]
 * @property {number} [range]
 * @property {number} at
 */

/**
 * Recovery / fallback (debounced from hard path failures).
 * @typedef {Object} NavRecoveryPayload
 * @property {string} context
 * @property {number} at
 * @property {string} [status]
 */

/**
 * Stuck / recovery outcome (emitted after handling `nav:recovery` and related fallbacks).
 * @typedef {Object} NavStuckPayload
 * @property {string} context
 * @property {number} at
 * @property {string} [status]
 * @property {boolean} [recovered] — whether `handleStuckRecovery` reported a real reset (not cooldown-blocked).
 */

/**
 * Reached current pathfinder goal.
 * @typedef {Object} NavArrivedPayload
 * @property {number} at
 * @property {string} [source] - e.g. `pathfinder`
 */

// ── Awareness ──

/**
 * Hostile or creeper proximity crossed the same thresholds as legacy voice warns.
 * @typedef {Object} AwarenessThreatDetectedPayload
 * @property {'creeper'|'hostile'} kind
 * @property {string} name - normalized mob name (e.g. `creeper`)
 * @property {number} distance
 * @property {number} at - epoch ms
 * @property {number} [entityId] - mineflayer entity id when available
 */

/**
 * Nearby **player** took damage (same distance / cooldown gates as legacy taunts).
 * @typedef {Object} AwarenessDamagedPayload
 * @property {string} username
 * @property {number} distance
 * @property {number} at
 */

/**
 * Nearby player died (same distance gate as legacy death lines).
 * @typedef {Object} AwarenessPlayerDeathNearbyPayload
 * @property {string} username
 * @property {number} distance
 * @property {number} at
 */

/**
 * Premium ore visible and premium-loot cooldown satisfied (before optional `askAssistant`).
 * @typedef {Object} AwarenessPremiumLootPayload
 * @property {string} [premiumOreName]
 * @property {number} [premiumOreDist]
 * @property {number} at
 */

// ── Voice ──

/**
 * @typedef {Object} VoiceSpeakPayload
 * @property {string} text
 */

/**
 * @typedef {Object} VoiceStopPayload
 * @property {boolean} [shutdownSilero] — default true: shut down Silero TTS subprocess
 */

// ── Movement / combat mode (gameplay wiring listens; not pathfinder internals) ──

/**
 * @typedef {Object} MovementSetIdlePayload
 * @property {number} at
 */

/**
 * @typedef {Object} MovementSetFollowPayload
 * @property {string} targetUsername
 * @property {number} at
 */

/**
 * @typedef {Object} MovementSetComePayload
 * @property {string} targetUsername
 * @property {number} at
 */

/**
 * @typedef {Object} CombatSetGuardPayload
 * @property {string} targetUsername
 * @property {number} at
 */

// ── Gameplay ──

/**
 * @typedef {Object} GameplayCraftGearPayload
 * @property {number} at
 */

/**
 * @typedef {Object} GameplayToggleFlightPayload
 * @property {boolean} enable
 * @property {number} at
 */

// ── Combat intents (listeners call attackEntity / stopAttack) ──

/**
 * @typedef {Object} CombatEngageEntityPayload
 * @property {string} entityName
 * @property {number} [entityId] — when set, {@link ../attackEntity.attackEntity} resolves this entity first
 * @property {string} [strategy]
 * @property {number} at
 */

/**
 * @typedef {Object} CombatStopAttackPayload
 * @property {number} at
 */

// ── Defend (opaque args forwarded by wiring to defend.*) ──

/**
 * @typedef {Object} DefendPatrolModePayload
 * @property {Object} [params]
 * @property {number} at
 */

/**
 * @typedef {Object} DefendDefendPointPayload
 * @property {Object} [params]
 * @property {number} at
 */

/**
 * @typedef {Object} DefendDefendEntityPayload
 * @property {Object} [params]
 * @property {number} at
 */

/**
 * @typedef {Object} DefendStopAllPayload
 * @property {number} at
 */

// ── Survival ──

/**
 * @typedef {Object} SurvivalSetPayload
 * @property {number} at
 */

/**
 * @typedef {Object} SurvivalStopPayload
 * @property {number} at
 * @property {string} [reason]
 */

// ── Intent audit ──

/**
 * @typedef {Object} IntentDispatchedPayload
 * @property {string} intentType
 * @property {number} at
 * @property {string} [coreState]
 */

/** @enum {string} */
const CoreEvents = Object.freeze({
  STATE_CHANGED: 'core:state_changed',
  SCHEDULER_TASK_REGISTERED: 'core:scheduler_task_registered',
  SCHEDULER_TASK_REMOVED: 'core:scheduler_task_removed',
  BRAIN_READY: 'core:brain_ready',
  BRAIN_SHUTDOWN: 'core:brain_shutdown'
})

/** @enum {string} */
const NavEvents = Object.freeze({
  GOTO: 'nav:goto',
  STOP: 'nav:stop',
  ARRIVED: 'nav:arrived',
  GOAL_SET: 'nav:goal_set',
  PATH_RESULT: 'nav:path_result',
  RECOVERY: 'nav:recovery',
  STUCK: 'nav:stuck'
})

/** @enum {string} */
const AwarenessEvents = Object.freeze({
  THREAT_DETECTED: 'awareness:threat_detected',
  DAMAGED: 'awareness:damaged',
  PLAYER_DEATH_NEARBY: 'awareness:player_death_nearby',
  PREMIUM_LOOT: 'awareness:premium_loot'
})

/** @enum {string} */
const VoiceEvents = Object.freeze({
  SPEAK: 'voice:speak',
  STOP: 'voice:stop'
})

/** @enum {string} */
const MovementEvents = Object.freeze({
  SET_IDLE: 'movement:set_idle',
  SET_FOLLOW: 'movement:set_follow',
  SET_COME: 'movement:set_come'
})

/** @enum {string} */
const GameplayEvents = Object.freeze({
  CRAFT_GEAR: 'gameplay:craft_gear',
  TOGGLE_FLIGHT: 'gameplay:toggle_flight'
})

/** @enum {string} */
const CombatEvents = Object.freeze({
  SET_GUARD: 'combat:set_guard',
  ENGAGE_ENTITY: 'combat:engage_entity',
  STOP_ATTACK: 'combat:stop_attack'
})

/** @enum {string} */
const DefendEvents = Object.freeze({
  PATROL_MODE: 'defend:patrol_mode',
  DEFEND_POINT: 'defend:defend_point',
  DEFEND_ENTITY: 'defend:defend_entity',
  STOP_ALL: 'defend:stop_all'
})

/** @enum {string} */
const SurvivalEvents = Object.freeze({
  SET_SURVIVAL: 'survival:set',
  STOP_SURVIVAL: 'survival:stop'
})

/** @enum {string} */
const IntentEvents = Object.freeze({
  DISPATCHED: 'intent:dispatched'
})

/**
 * @type {Readonly<Record<string, string>>}
 */
const CORE_EVENT_DEFINITIONS = Object.freeze({
  [CoreEvents.STATE_CHANGED]: 'CoreStateChangedPayload',
  [CoreEvents.SCHEDULER_TASK_REGISTERED]: 'CoreSchedulerTaskRegisteredPayload',
  [CoreEvents.SCHEDULER_TASK_REMOVED]: 'CoreSchedulerTaskRemovedPayload',
  [CoreEvents.BRAIN_READY]: 'CoreBrainReadyPayload',
  [CoreEvents.BRAIN_SHUTDOWN]: 'CoreBrainShutdownPayload'
})

/**
 * @type {Readonly<Record<string, string>>}
 */
const NAV_EVENT_DEFINITIONS = Object.freeze({
  [NavEvents.GOTO]: 'NavGotoPayload',
  [NavEvents.STOP]: 'NavStopPayload',
  [NavEvents.ARRIVED]: 'NavArrivedPayload',
  [NavEvents.GOAL_SET]: 'NavGoalSetPayload',
  [NavEvents.PATH_RESULT]: 'NavPathResultPayload',
  [NavEvents.RECOVERY]: 'NavRecoveryPayload',
  [NavEvents.STUCK]: 'NavStuckPayload'
})

/**
 * @type {Readonly<Record<string, string>>}
 */
const AWARENESS_EVENT_DEFINITIONS = Object.freeze({
  [AwarenessEvents.THREAT_DETECTED]: 'AwarenessThreatDetectedPayload',
  [AwarenessEvents.DAMAGED]: 'AwarenessDamagedPayload',
  [AwarenessEvents.PLAYER_DEATH_NEARBY]: 'AwarenessPlayerDeathNearbyPayload',
  [AwarenessEvents.PREMIUM_LOOT]: 'AwarenessPremiumLootPayload'
})

/**
 * @type {Readonly<Record<string, string>>}
 */
const VOICE_EVENT_DEFINITIONS = Object.freeze({
  [VoiceEvents.SPEAK]: 'VoiceSpeakPayload',
  [VoiceEvents.STOP]: 'VoiceStopPayload'
})

/**
 * @type {Readonly<Record<string, string>>}
 */
const MOVEMENT_EVENT_DEFINITIONS = Object.freeze({
  [MovementEvents.SET_IDLE]: 'MovementSetIdlePayload',
  [MovementEvents.SET_FOLLOW]: 'MovementSetFollowPayload',
  [MovementEvents.SET_COME]: 'MovementSetComePayload'
})

/**
 * @type {Readonly<Record<string, string>>}
 */
const GAMEPLAY_EVENT_DEFINITIONS = Object.freeze({
  [GameplayEvents.CRAFT_GEAR]: 'GameplayCraftGearPayload',
  [GameplayEvents.TOGGLE_FLIGHT]: 'GameplayToggleFlightPayload'
})

/**
 * @type {Readonly<Record<string, string>>}
 */
const COMBAT_EVENT_DEFINITIONS = Object.freeze({
  [CombatEvents.SET_GUARD]: 'CombatSetGuardPayload',
  [CombatEvents.ENGAGE_ENTITY]: 'CombatEngageEntityPayload',
  [CombatEvents.STOP_ATTACK]: 'CombatStopAttackPayload'
})

/**
 * @type {Readonly<Record<string, string>>}
 */
const DEFEND_EVENT_DEFINITIONS = Object.freeze({
  [DefendEvents.PATROL_MODE]: 'DefendPatrolModePayload',
  [DefendEvents.DEFEND_POINT]: 'DefendDefendPointPayload',
  [DefendEvents.DEFEND_ENTITY]: 'DefendDefendEntityPayload',
  [DefendEvents.STOP_ALL]: 'DefendStopAllPayload'
})

/** @type {Readonly<Record<string, string>>} */
const SURVIVAL_EVENT_DEFINITIONS = Object.freeze({
  [SurvivalEvents.SET_SURVIVAL]: 'SurvivalSetPayload',
  [SurvivalEvents.STOP_SURVIVAL]: 'SurvivalStopPayload'
})

const INTENT_EVENT_DEFINITIONS = Object.freeze({
  [IntentEvents.DISPATCHED]: 'IntentDispatchedPayload'
})

/**
 * @type {Readonly<Record<string, string>>}
 */
const REGISTERED_EVENT_DEFINITIONS = Object.freeze({
  ...CORE_EVENT_DEFINITIONS,
  ...NAV_EVENT_DEFINITIONS,
  ...AWARENESS_EVENT_DEFINITIONS,
  ...VOICE_EVENT_DEFINITIONS,
  ...MOVEMENT_EVENT_DEFINITIONS,
  ...GAMEPLAY_EVENT_DEFINITIONS,
  ...COMBAT_EVENT_DEFINITIONS,
  ...DEFEND_EVENT_DEFINITIONS,
  ...SURVIVAL_EVENT_DEFINITIONS,
  ...INTENT_EVENT_DEFINITIONS
})

/** @type {ReadonlySet<string>} */
const REGISTERED_EVENT_NAMES = new Set(Object.keys(REGISTERED_EVENT_DEFINITIONS))

/** Core-only names (subset of `REGISTERED_EVENT_NAMES`). */
const CORE_EVENT_NAMES = new Set(Object.keys(CORE_EVENT_DEFINITIONS))

/**
 * @param {string} name
 * @returns {boolean}
 */
function isRegisteredBusEvent (name) {
  return typeof name === 'string' && REGISTERED_EVENT_NAMES.has(name)
}

/** @param {string} name @returns {boolean} */
function isCoreEventName (name) {
  return isRegisteredBusEvent(name)
}

module.exports = {
  CoreEvents,
  NavEvents,
  AwarenessEvents,
  VoiceEvents,
  MovementEvents,
  GameplayEvents,
  CombatEvents,
  DefendEvents,
  SurvivalEvents,
  IntentEvents,
  CORE_EVENT_DEFINITIONS,
  NAV_EVENT_DEFINITIONS,
  AWARENESS_EVENT_DEFINITIONS,
  VOICE_EVENT_DEFINITIONS,
  MOVEMENT_EVENT_DEFINITIONS,
  GAMEPLAY_EVENT_DEFINITIONS,
  COMBAT_EVENT_DEFINITIONS,
  DEFEND_EVENT_DEFINITIONS,
  SURVIVAL_EVENT_DEFINITIONS,
  INTENT_EVENT_DEFINITIONS,
  REGISTERED_EVENT_DEFINITIONS,
  REGISTERED_EVENT_NAMES,
  CORE_EVENT_NAMES,
  isRegisteredBusEvent,
  isCoreEventName
}
