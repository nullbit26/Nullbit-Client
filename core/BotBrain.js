'use strict'

const { EventBus } = require('./EventBus')
const { Scheduler } = require('./Scheduler')
const { StateManager, CoreStates } = require('./StateManager')
const {
  CoreEvents,
  NavEvents,
  MovementEvents,
  GameplayEvents,
  CombatEvents,
  DefendEvents,
  SurvivalEvents,
  IntentEvents
} = require('./EventRegistry')
const { IntentTypes } = require('./IntentTypes')
const { createLogger } = require('../utils/Logger')
const { NavigationController } = require('../navigation/NavigationController')
const { OperationalMemory } = require('../memory/OperationalMemory')
const { AwarenessSystem } = require('../systems/AwarenessSystem')
const { VoiceSystem } = require('../systems/VoiceSystem')
const { FollowSystem } = require('../systems/FollowSystem')
const { CombatSystem } = require('../systems/CombatSystem')
const { DefendSystem } = require('../systems/DefendSystem')
const { RecoverySystem } = require('../systems/RecoverySystem')
const { SurvivalSystem } = require('../systems/SurvivalSystem')
const { AutoGearSystem } = require('../systems/AutoGearSystem')
const { RespawnRecoverySystem } = require('../systems/RespawnRecoverySystem')
const { AntiDrownSystem } = require('../systems/AntiDrownSystem')
const { TacticalDecisionEngine } = require('./TacticalDecisionEngine')

/**
 * Central orchestrator: EventBus, StateManager, Scheduler, VoiceSystem, NavigationController,
 * OperationalMemory, AwarenessSystem, intent queue, Follow/Combat/Defend/Recovery systems.
 *
 * @typedef {import('../systems/AwarenessSystem').AwarenessDeps} AwarenessDeps
 *
 * @typedef {Object} BotBrainOptions
 * @property {{ strict?: boolean, maxListeners?: number }} [eventBus]
 * @property {import('../utils/Logger').Logger} [logger]
 * @property {boolean} [eventBusLog] — default true
 * @property {boolean} [navigation] — set false to skip `NavigationController` (default true)
 * @property {import('../config')} [config] — with `utils`, enables built-in {@link ../systems/VoiceSystem}
 * @property {{ log: Function }} [utils] — logger bag from `createUtils(bot)` when `config` is set
 */

/**
 * @typedef {Object} GameplaySystemsCtx
 * @property {import('mineflayer').Bot} bot
 * @property {any} config
 * @property {any} state
 * @property {any} utils
 * @property {any} movementActions
 * @property {any} combatActions
 * @property {any} defend
 * @property {{ schedule: (reason: string) => void, isShuttingDown?: () => boolean } | null | undefined} [reconnect]
 */

class BotBrain {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {BotBrainOptions} [options]
   */
  constructor (bot, options = {}) {
    if (!bot) throw new Error('[BotBrain] bot is required')

    /** @private @type {BotBrainOptions} */
    this._opts = options

    /** @readonly */
    this.bot = bot

    /** @readonly @type {import('../utils/Logger').Logger} */
    this.log = options.logger || createLogger({ prefix: '[BRAIN]' })

    /** @readonly @type {EventBus} */
    this.eventBus = new EventBus(options.eventBus || {})

    /** @readonly @type {StateManager} */
    this.state = new StateManager(this.eventBus)

    /** @readonly @type {Scheduler} */
    this.scheduler = new Scheduler(bot, {
      eventBus: this.eventBus,
      logger: this.log.child(' [SCHED]')
    })

    /** @readonly @type {import('../memory/OperationalMemory').OperationalMemory} */
    this.memory = new OperationalMemory()

    /** @readonly @type {VoiceSystem | null} */
    this.voiceSystem = null
    /** @readonly @type {{ speak: Function, shutdownSilero: Function }} */
    this.voice = {
      speak: async () => {},
      shutdownSilero: () => {}
    }
    if (options.config && options.utils) {
      this.voiceSystem = new VoiceSystem({
        bot,
        eventBus: this.eventBus,
        config: options.config,
        utils: options.utils
      })
      this.voice = this.voiceSystem.getVoiceHandle()
    }

    /** @readonly @type {AwarenessSystem | null} */
    this.awarenessSystem = null

    /** @readonly @type {FollowSystem | null} */
    this.followSystem = null
    /** @readonly @type {CombatSystem | null} */
    this.combatSystem = null
    /** @readonly @type {DefendSystem | null} */
    this.defendSystem = null
    /** @readonly @type {SurvivalSystem | null} */
    this.survivalSystem = null
    /** @readonly @type {AutoGearSystem | null} */
    this.autoGearSystem = null
    /** @readonly @type {RespawnRecoverySystem | null} */
    this.respawnRecoverySystem = null
    /** @readonly @type {AntiDrownSystem | null} */
    this.antiDrownSystem = null
    /** @readonly @type {TacticalDecisionEngine | null} */
    this.tacticalEngine = null
    this.decisionContext = null

    /** @readonly @type {RecoverySystem | null} */
    this.recoverySystem = null

    /** @readonly @type {NavigationController | null} */
    this.navigation =
      options.navigation === false
        ? null
        : new NavigationController(bot, { eventBus: this.eventBus, logger: this.log })

    /** @private @type {object[]} */
    this._intentQueue = []
    this._fleeCooldownUntil = 0
    /** @private */
    this._lastMode = null

    /** @private */
    this._initialized = false
    /** @private @type {(() => void) | null} */
    this._detachBusLog = null
  }

  setFleeCooldown (ms) {
    this._fleeCooldownUntil = Date.now() + ms
  }

  isFleeCooldown () {
    return Date.now() < this._fleeCooldownUntil
  }

  setLastMode (mode) {
    this._lastMode = mode || null
  }

  getLastMode () {
    return this._lastMode || null
  }

  /**
   * Wire `AwarenessSystem` once `ai` / environment deps exist.
   * @param {AwarenessDeps} deps
   */
  attachAwarenessSystem (deps) {
    if (!deps || typeof deps.scanEnvironment !== 'function') {
      throw new Error('[BotBrain] attachAwarenessSystem: scanEnvironment is required')
    }
    if (this.awarenessSystem) {
      try {
        this.awarenessSystem.destroy('reconfigure')
      } catch (_) {}
      this.awarenessSystem = null
    }
    this.awarenessSystem = new AwarenessSystem({
      brain: this,
      ...deps
    })
    if (this._initialized) {
      this.awarenessSystem.init()
    }
  }

  /**
   * @param {GameplaySystemsCtx} ctx
   */
  attachGameplaySystems (ctx) {
    if (!ctx?.movementActions || !ctx?.combatActions || !ctx?.defend) {
      throw new Error('[BotBrain] attachGameplaySystems: movementActions, combatActions, defend required')
    }
    this.followSystem?.destroy?.()
    this.combatSystem?.destroy?.()
    this.defendSystem?.destroy?.()
    this.recoverySystem?.destroy?.()
    this.recoverySystem = new RecoverySystem({
      bot: ctx.bot,
      eventBus: this.eventBus,
      config: ctx.config,
      state: ctx.state,
      movementActions: ctx.movementActions,
      logger: this.log,
      reconnect: ctx.reconnect != null ? ctx.reconnect : null
    })
    this.followSystem = new FollowSystem({
      bot: ctx.bot,
      brain: this,
      config: ctx.config,
      state: ctx.state,
      utils: ctx.utils,
      movementActions: ctx.movementActions,
      combatActions: ctx.combatActions
    })
    this.combatSystem = new CombatSystem({ bot: ctx.bot, brain: this, config: ctx.config })
    this.defendSystem = new DefendSystem({ brain: this, defend: ctx.defend })
    this.survivalSystem?.destroy?.()
    this.survivalSystem = new SurvivalSystem({ bot: ctx.bot, brain: this, config: ctx.config })
    this.autoGearSystem?.destroy?.()
    this.autoGearSystem = new AutoGearSystem({ bot: ctx.bot, brain: this })
    this.respawnRecoverySystem?.destroy?.()
    this.respawnRecoverySystem = new RespawnRecoverySystem({ bot: ctx.bot, brain: this })
    this.antiDrownSystem?.destroy?.()
    this.antiDrownSystem = new AntiDrownSystem({ bot: ctx.bot, brain: this })
    this.tacticalEngine?.destroy?.()
    this.tacticalEngine = new TacticalDecisionEngine({ bot: ctx.bot, brain: this, config: ctx.config })
    if (this._initialized) {
      this.defendSystem.init()
      this.followSystem.init()
      this.combatSystem.init()
      this.recoverySystem.init()
      this.survivalSystem.init()
      this.autoGearSystem.init()
      this.respawnRecoverySystem.init()
      this.antiDrownSystem.init()
      this.tacticalEngine.init()
    }
  }

  /**
   * @param {object} intent — must include string `type` (see {@link ./IntentTypes}).
   */
  pushIntent (intent) {
    if (!intent || typeof intent.type !== 'string') {
      this.log.warn('pushIntent ignored (bad intent)')
      return
    }
    this._intentQueue.push(intent)
    this._drainIntentQueue()
  }

  /** @private */
  _drainIntentQueue () {
    while (this._intentQueue.length) {
      const intent = this._intentQueue.shift()
      try {
        this._dispatchIntent(intent)
      } catch (e) {
        this.log.error('intent dispatch failed', e instanceof Error ? e.message : String(e))
      }
    }
  }

  /** @private @param {object} intent */
  _dispatchIntent (intent) {
    const at = Date.now()
    const core = this.state.getState()
    this.eventBus.emit(IntentEvents.DISPATCHED, {
      intentType: intent.type,
      at,
      coreState: core
    })

    switch (intent.type) {
      case IntentTypes.BOT_STOP:
        this.eventBus.emit(CombatEvents.STOP_ATTACK, { at })
        this.eventBus.emit(DefendEvents.STOP_ALL, { at })
        this.eventBus.emit(SurvivalEvents.STOP_SURVIVAL, { at })
        this.eventBus.emit(MovementEvents.SET_IDLE, { at })
        this.state.transition(CoreStates.IDLE)
        break
      case IntentTypes.DEFEND_STOP:
        this.eventBus.emit(DefendEvents.STOP_ALL, { at })
        break
      case IntentTypes.MOVEMENT_SET_FOLLOW:
        this.state.transition(CoreStates.FOLLOWING, { targetUsername: intent.targetUsername })
        this.eventBus.emit(MovementEvents.SET_FOLLOW, {
          targetUsername: String(intent.targetUsername || ''),
          at
        })
        break
      case IntentTypes.MOVEMENT_SET_COME:
        this.state.transition(CoreStates.FOLLOWING)
        this.eventBus.emit(MovementEvents.SET_COME, {
          targetUsername: String(intent.targetUsername || ''),
          at
        })
        break
      case IntentTypes.NAV_GOTO: {
        const x = Number(intent.x)
        const y = Number(intent.y)
        const z = Number(intent.z)
        const range = Number.isFinite(Number(intent.range)) ? Number(intent.range) : 2
        if (![x, y, z].every(Number.isFinite)) {
          this.log.warn('NAV_GOTO dropped: non-finite coords')
          break
        }
        this.eventBus.emit(NavEvents.GOTO, { kind: 'near', x, y, z, range })
        break
      }
      case IntentTypes.GAMEPLAY_CRAFT_GEAR:
        this.eventBus.emit(GameplayEvents.CRAFT_GEAR, { at })
        break
      case IntentTypes.GAMEPLAY_TOGGLE_FLIGHT: {
        const en = intent.enable === true || intent.enable === 'true' || intent.enable === 1 || intent.enable === '1'
        this.eventBus.emit(GameplayEvents.TOGGLE_FLIGHT, { enable: !!en, at })
        break
      }
      case IntentTypes.COMBAT_ENGAGE_ENTITY:
        this.state.transition(CoreStates.COMBAT, { entityName: intent.entityName })
        this.eventBus.emit(CombatEvents.ENGAGE_ENTITY, {
          entityName: String(intent.entityName || ''),
          strategy: intent.strategy != null ? String(intent.strategy) : 'aggressive',
          at
        })
        break
      case IntentTypes.COMBAT_STOP_ATTACK:
        this.eventBus.emit(CombatEvents.STOP_ATTACK, { at })
        break
      case IntentTypes.COMBAT_SET_GUARD:
        this.eventBus.emit(CombatEvents.SET_GUARD, {
          targetUsername: String(intent.targetUsername || ''),
          at
        })
        break
      case IntentTypes.DEFEND_PATROL:
        this.eventBus.emit(DefendEvents.PATROL_MODE, {
          params: intent.params && typeof intent.params === 'object' ? intent.params : {},
          at
        })
        break
      case IntentTypes.DEFEND_POINT:
        this.eventBus.emit(DefendEvents.DEFEND_POINT, {
          params: intent.params && typeof intent.params === 'object' ? intent.params : {},
          at
        })
        break
      case IntentTypes.DEFEND_ENTITY:
        this.eventBus.emit(DefendEvents.DEFEND_ENTITY, {
          params: intent.params && typeof intent.params === 'object' ? intent.params : {},
          at
        })
        break
      default:
        this.log.warn('unknown intent type', String(intent.type))
    }
  }

  init () {
    if (this._initialized) return
    this._initialized = true
    if (this._opts.eventBusLog !== false) {
      this._detachBusLog = this.log.attachEventBus(this.eventBus)
    }
    this.voiceSystem?.init?.()
    this.recoverySystem?.init?.()
    this.navigation?.init?.()
    this.awarenessSystem?.init?.()
    this.defendSystem?.init?.()
    this.followSystem?.init?.()
    this.combatSystem?.init?.()
    this.survivalSystem?.init?.()
    this.autoGearSystem?.init?.()
    this.respawnRecoverySystem?.init?.()
    this.antiDrownSystem?.init?.()
    this.tacticalEngine?.init?.()
    // Auto-enable survival (eat) on every init — bot should always eat when safe
    this.eventBus.emit(SurvivalEvents.SET_SURVIVAL, { at: Date.now(), source: 'auto' })
    this.log.info('initialized')
    this.eventBus.emit(CoreEvents.BRAIN_READY, { at: Date.now() })
  }

  /**
   * @param {string} [reason]
   */
  destroy (reason) {
    this.eventBus.emit(CoreEvents.BRAIN_SHUTDOWN, {
      at: Date.now(),
      reason: reason != null ? String(reason) : undefined
    })
    if (typeof this._detachBusLog === 'function') {
      this._detachBusLog()
      this._detachBusLog = null
    } else {
      this.log.detachEventBus()
    }
    this.partyIFF?.destroy?.()
    this.tacticalEngine?.destroy?.()
    this.antiDrownSystem?.destroy?.()
    this.respawnRecoverySystem?.destroy?.()
    this.autoGearSystem?.destroy?.()
    this.survivalSystem?.destroy?.()
    this.combatSystem?.destroy?.()
    this.followSystem?.destroy?.()
    this.defendSystem?.destroy?.()
    this.awarenessSystem?.destroy?.(reason)
    this.recoverySystem?.destroy?.()
    this.navigation?.destroy?.()
    this.voiceSystem?.destroy?.()
    this.scheduler.destroy()
    this.eventBus.removeAllListeners()
    this._intentQueue.length = 0
    this._initialized = false
    this.log.info('destroyed', reason != null && String(reason) ? String(reason) : undefined)
  }
}

module.exports = { BotBrain }
