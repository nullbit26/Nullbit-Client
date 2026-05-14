'use strict'

const { NavEvents, MovementEvents, CombatEvents } = require('../core/EventRegistry')
const { CoreStates } = require('../core/StateManager')
const { isCombatSessionActive } = require('../attackEntity')

const TASK_FOLLOW = 'follow_system_nav'

/**
 * Bus-driven follow/guard: mirrors `movement.repathToTarget` / `shouldRepathTarget` math, updates
 * {@link ../memory/OperationalMemory} with the tracked target position, and emits `nav:goto` for
 * {@link ../navigation/NavigationController}. Legacy `repathToTarget` is suppressed via `state.navFollowViaBus`.
 *
 * @typedef {Object} FollowSystemCtx
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/BotBrain').BotBrain} brain
 * @property {any} config
 * @property {any} state
 * @property {{ getPlayerEntity: Function }} utils
 * @property {any} movementActions
 * @property {any} combatActions
 */

class FollowSystem {
  /**
   * @param {FollowSystemCtx} ctx
   */
  constructor (ctx) {
    if (!ctx?.brain) throw new Error('[FollowSystem] brain is required')
    this._bot = ctx.bot
    this._brain = ctx.brain
    this._bus = ctx.brain.eventBus
    this._memory = ctx.brain.memory
    this._config = ctx.config
    this._state = ctx.state
    this._getPlayerEntity = ctx.utils.getPlayerEntity
    this._movement = ctx.movementActions
    this._combat = ctx.combatActions

    this._onSetFollow = this._onSetFollow.bind(this)
    this._onSetCome = this._onSetCome.bind(this)
    this._onSetIdle = this._onSetIdle.bind(this)
    this._onSetGuard = this._onSetGuard.bind(this)
    this._tickDeferred = this._tickDeferred.bind(this)

    /** @private */
    this._wired = false
  }

  /** @private */
  _enableBusNav () {
    this._state.navFollowViaBus = true
  }

  /** @private */
  _disableBusNav () {
    this._state.navFollowViaBus = false
  }

  /** @private */
  _onSetFollow (payload) {
    const u = payload && payload.targetUsername != null ? String(payload.targetUsername) : ''
    if (!u) return
    this._brain.setLastMode({ type: 'follow', targetUsername: u })
    this._enableBusNav()
    this._movement.setModeFollow(u)
  }

  /** @private */
  _onSetCome (payload) {
    const u = payload && payload.targetUsername != null ? String(payload.targetUsername) : ''
    if (!u) return
    this._brain.setLastMode({ type: 'come', targetUsername: u })
    this._disableBusNav()
    this._movement.setModeCome(u)
  }

  /** @private */
  _onSetIdle () {
    this._brain.setLastMode(null)
    this._disableBusNav()
    this._memory.setFollowTarget(null)
    this._movement.setModeIdle()
  }

  /** @private */
  _onSetGuard (payload) {
    const u = payload && payload.targetUsername != null ? String(payload.targetUsername) : ''
    if (!u) return
    this._brain.setLastMode({ type: 'guard', targetUsername: u })
    this._enableBusNav()
    this._combat.setModeGuard(u)
  }

  /**
   * Same gates as `movement.shouldRepathTarget` / `repathToTarget` (GoalFollow distance → GoalNear range).
   * @private
   */
  _shouldRepathTarget (targetEntity, dist) {
    const tickSinceRepath = this._state.tickCounter - this._state.lastRepathTick
    if (tickSinceRepath < this._config.followRefreshTicks) return false
    if (!this._bot.entity || !targetEntity) return false
    const distance = this._bot.entity.position.distanceTo(targetEntity.position)
    return distance > dist + this._config.minFollowRepathDistance
  }

  /** @private */
  _tickDeferred () {
    queueMicrotask(() => this._tickFollowNav())
  }

  /** @private */
  _tickFollowNav () {
    if (this._brain.state.getState() === CoreStates.FLEE) return
    if (this._brain.state.getState() === CoreStates.COMBAT) return
    if (isCombatSessionActive()) return
    if (!(this._state.mode === 'follow' || this._state.mode === 'guard')) return
    if (!this._state.navFollowViaBus) return
    if (this._state.isRecovering && Date.now() < this._state.recoverUntil) return
    if (this._state.repathCooldownTicks > 0) return

    const targetEntity = this._getPlayerEntity(this._state.targetUsername)
    if (!targetEntity?.position) {
      this._memory.setFollowTarget(null)
      return
    }

    const p = targetEntity.position
    this._memory.setFollowTarget({
      username: String(this._state.targetUsername || ''),
      x: p.x,
      y: p.y,
      z: p.z,
      mode: this._state.mode,
      at: Date.now()
    })

    const dist = this._state.mode === 'guard' ? this._config.guardFollowDistance : this._config.followDistance
    const force = false
    if (!force && !this._shouldRepathTarget(targetEntity, dist)) return

    this._bus.emit(NavEvents.GOTO, {
      kind: 'near',
      x: p.x,
      y: p.y,
      z: p.z,
      range: dist
    })
    this._state.lastRepathTick = this._state.tickCounter
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bus.on(MovementEvents.SET_FOLLOW, this._onSetFollow)
    this._bus.on(MovementEvents.SET_COME, this._onSetCome)
    this._bus.on(MovementEvents.SET_IDLE, this._onSetIdle)
    this._bus.on(CombatEvents.SET_GUARD, this._onSetGuard)
    this._brain.scheduler.registerPeriodic(1, this._tickDeferred, { id: TASK_FOLLOW })
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._brain.scheduler.unregister(TASK_FOLLOW)
    this._bus.off(MovementEvents.SET_FOLLOW, this._onSetFollow)
    this._bus.off(MovementEvents.SET_COME, this._onSetCome)
    this._bus.off(MovementEvents.SET_IDLE, this._onSetIdle)
    this._bus.off(CombatEvents.SET_GUARD, this._onSetGuard)
    this._disableBusNav()
    this._memory.setFollowTarget(null)
  }
}

module.exports = { FollowSystem }
