'use strict'

const { CombatEvents, NavEvents, DefendEvents, MovementEvents } = require('../core/EventRegistry')
const { CoreStates } = require('../core/StateManager')
const { attackEntity, stopAttack, isCombatSessionActive } = require('../attackEntity')
const { equipBestWeapon } = require('../features/combatEquipment')
const { findBestHealPotion, isSplashLikePotion } = require('../utils/combatConsumables')
const { HealController } = require('../combat/flee/HealController')
const { evaluateThreatPressure } = require('../combat/flee/evaluateThreatPressure')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FLEE_TICK_TASK = 'combat_system_flee_tick'
const FLEE_PHASES = Object.freeze({
  BREAK_CONTACT: 'BREAK_CONTACT',
  STABILIZE: 'STABILIZE',
  RECOVER: 'RECOVER'
})
const FLEE_REPLAN_REASONS = Object.freeze({
  NO_PATH: 'no_path',
  TIMEOUT: 'timeout',
  PRESSURE_SPIKE: 'pressure_spike',
  DISTANCE_COLLAPSE: 'distance_collapse',
  PLAN_TTL_EXCEEDED: 'plan_ttl_exceeded'
})

/** Еда, которую не пытаемся есть в панике (яд / дебаффы). */
const FLEE_FOOD_DENYLIST = new Set([
  'rotten_flesh',
  'spider_eye',
  'pufferfish',
  'poisonous_potato',
  'chorus_fruit'
])

/**
 * @param {import('mineflayer').Bot} bot
 * @param {any} config
 */
function shouldFleeByHp (bot, config) {
  if (!config.combatFleeEnabled) return false
  if (!bot.entity || bot.health == null) return false
  const max = Number(bot.maxHealth) > 0 ? Number(bot.maxHealth) : 20
  const hp = Number(bot.health)
  const critAbs = Number(config.combatFleeCriticalHp) || 6
  const critRatio = Number(config.combatFleeCriticalRatio) || 0.3
  if (hp <= critAbs) return true
  if (hp / max <= critRatio) return true
  return false
}

/**
 * Risk-based retreat gate on top of hard HP thresholds.
 * Keeps behavior low-risk: hard critical HP still wins immediately.
 * @param {import('mineflayer').Bot} bot
 * @param {any} config
 * @param {{ shouldEnterFleeByRisk?: boolean }} pressure
 */
function shouldFleeByRisk (bot, config, pressure) {
  if (!config.combatFleeEnabled) return false
  if (!config.combatFleeRetreatScoreEnabled) return false
  if (!bot.entity || bot.health == null) return false
  if (!pressure?.shouldEnterFleeByRisk) return false
  const gate = Number(config.combatFleeRetreatRiskHpRatioMax)
  if (Number.isFinite(gate) && gate > 0 && gate < 1) {
    const max = Number(bot.maxHealth) > 0 ? Number(bot.maxHealth) : 20
    const hp = Number(bot.health)
    if (Number.isFinite(hp) && max > 0 && hp / max > gate) return false
  }
  return true
}

/**
 * Единый порог «достаточно здоров, чтобы выйти из FLEE по HP» (сердца mineflayer).
 * Не используем отдельно `hp/max >= ratio` без согласования с абсолютом — иначе при низком maxHealth
 * можно было бы выйти при ~10/12 HP.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {any} config
 */
function getFleeSafeHpThreshold (bot, config) {
  if (!bot.entity || bot.health == null) return 16
  const max = Number(bot.maxHealth) > 0 ? Number(bot.maxHealth) : 20
  const safeAbs = Number(config.combatFleeSafeHp) || 16
  const ratio = Math.min(1, Math.max(0, Number(config.combatFleeSafeRatio) || 0.8))
  const fromRatio = Math.ceil(max * ratio)
  return Math.min(max, Math.max(safeAbs, fromRatio))
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {any} config
 */
function isHpAtOrAboveFleeSafe (bot, config) {
  if (!bot.entity || bot.health == null) return false
  const hp = Number(bot.health)
  if (!Number.isFinite(hp)) return false
  return hp >= getFleeSafeHpThreshold(bot, config)
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {any} config
 */
function hasConsumableHeal (bot, config) {
  if (findBestFoodItem(bot)) return true
  const thr = getFleeSafeHpThreshold(bot, config)
  return !!findBestHealPotion(bot, thr)
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {import('../memory/OperationalMemory').OperationalMemory} memory
 * @param {number} minDist
 * @returns {{ far: boolean, nearest: number | null }}
 */
function threatDistanceSummary (bot, memory, minDist) {
  if (!bot.entity?.position) return { far: true, nearest: null }
  const pos = bot.entity.position
  let nearest = Infinity

  for (const t of memory.getCurrentThreats()) {
    const e = bot.entities[t.id]
    if (!e?.position) continue
    if (e.health != null && e.health <= 0) continue
    const d = pos.distanceTo(e.position)
    if (d < nearest) nearest = d
  }

  const la = memory.getLastAttacker()
  if (la?.username) {
    const ent =
      bot.players[la.username]?.entity ||
      Object.values(bot.players || {}).find((p) => p.username?.toLowerCase() === la.username.toLowerCase())?.entity
    if (ent?.position) {
      const d = pos.distanceTo(ent.position)
      if (d < nearest) nearest = d
    }
  }

  if (!Number.isFinite(nearest)) return { far: true, nearest: null }
  return { far: nearest >= minDist, nearest }
}

/**
 * Лучшая еда из инвентаря по `effectiveQuality` из registry (без deprecated API).
 * @param {import('mineflayer').Bot} bot
 */
function findBestFoodItem (bot) {
  const byName = bot.registry?.foodsByName
  if (!byName) return null
  let best = null
  let bestQ = -1
  for (const item of bot.inventory.items()) {
    if (!item?.name || FLEE_FOOD_DENYLIST.has(item.name)) continue
    const fd = byName[item.name]
    if (!fd) continue
    const q = Number(fd.effectiveQuality ?? fd.foodPoints ?? 0)
    if (q > bestQ) {
      bestQ = q
      best = item
    }
  }
  return best
}

/**
 * Цель для `nav:goto`: несколько блоков от бота по **XZ-вектору от ближайшего врага** (или спиной к `yaw`, если врага нет).
 * NavigationController подписан на `nav:goto` и вызывает `pathfinder.setGoal(GoalNear)` — тот же канал, что у FollowSystem.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('../memory/OperationalMemory').OperationalMemory} memory
 * @param {any} config
 */
function computeFleeGoal (bot, memory, config) {
  const pos = bot.entity.position
  const navBoost = Math.max(4, Math.min(24, Number(config.combatFleeNavDistance) || 12))
  const arriveR = Math.min(2.5, Math.max(1, Number(config.combatFleeGoalArrivalRange) || 1.5))
  const minThreat = Math.min(12, Math.max(6, Number(config.combatFleeMinThreatBlocks) || 8))

  // Собираем все угрозы
  const threats = []

  for (const t of memory.getCurrentThreats()) {
    const e = bot.entities[t.id]
    if (!e?.position) continue
    if (e.health != null && e.health <= 0) continue
    threats.push(e.position)
  }

  if (!threats.length) {
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || e.id === bot.entity?.id) continue
      if (!e.position) continue
      if (e.health != null && e.health <= 0) continue
      if (e.type !== 'player' && e.type !== 'mob' && e.type !== 'hostile') continue
      const d2 = pos.distanceTo(e.position)
      if (!Number.isFinite(d2) || d2 >= 32) continue
      threats.push(e.position)
    }
  }

  // Считаем суммарный вектор от ВСЕХ угроз
  let ax = 0
  let az = 0
  if (threats.length) {
    for (const tp of threats) {
      const dx = pos.x - tp.x
      const dz = pos.z - tp.z
      const d2 = Math.hypot(dx, dz)
      if (d2 < 0.01) continue
      // Ближе враг — сильнее вес
      const weight = 1 / Math.max(1, d2)
      ax += (dx / d2) * weight
      az += (dz / d2) * weight
    }
  }

  let nx
  let nz
  const alen = Math.hypot(ax, az)
  if (alen > 0.001) {
    nx = ax / alen
    nz = az / alen
  } else {
    const yaw = bot.entity.yaw ?? 0
    nx = -Math.sin(yaw)
    nz = -Math.cos(yaw)
  }

  const d = Math.max(minThreat, navBoost)
  return {
    x: pos.x + nx * d,
    y: pos.y,
    z: pos.z + nz * d,
    range: arriveR
  }
}

/** Имя для `attackEntity` после FLEE: игрок — `username`; иначе displayName, затем registry `name`, затем `type`. */
function reengageLabelFromEntity (e) {
  if (!e) return ''
  if (e.type === 'player' && e.username) return String(e.username)
  const d = e.displayName
  const disp = d == null || d === '' ? '' : typeof d === 'string' ? d : String(d)
  if (disp) return disp
  if (e.name) return String(e.name)
  if (e.type) return String(e.type)
  return ''
}

/**
 * Bridges combat intents on the EventBus to existing `attackEntity` / `stopAttack`
 * and owns low-HP **FLEE** (stop attack, bus `nav:goto` away, consume food).
 * Flee targets come from `OperationalMemory.currentThreats`, filled by {@link ./AwarenessSystem}
 * using {@link PartyIFFSystem} (hostile + aggro).
 *
 * @typedef {Object} CombatSystemCtx
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/BotBrain').BotBrain} brain
 * @property {any} config
 */

class CombatSystem {
  /**
   * @param {CombatSystemCtx} ctx
   */
  constructor (ctx) {
    if (!ctx?.brain) throw new Error('[CombatSystem] brain is required')
    if (!ctx?.config) throw new Error('[CombatSystem] config is required')
    this._bot = ctx.bot
    this._brain = ctx.brain
    this._bus = ctx.brain.eventBus
    this._voice = ctx.brain.voice
    this._memory = ctx.brain.memory
    this._config = ctx.config

    this._onEngage = this._onEngage.bind(this)
    this._onStop = this._onStop.bind(this)
    this._onHealth = this._onHealth.bind(this)
    this._fleeTick = this._fleeTick.bind(this)

    /** @private */
    this._wired = false
    /** @private */
    this._fleeTaskRegistered = false
    /** @private */
    this._fleeAnnounced = false
    /** @private @type {number} epoch ms when current FLEE started */
    this._fleeStartedAt = 0
    /** @private @type {boolean} */
    this._fleeNavLocked = false
    /** @private @type {number} epoch ms when last flee nav:goto was emitted */
    this._lastFleeNavAt = 0
    /** @private @type {ReturnType<typeof setTimeout> | null} */
    this._fleeWatchdogTimer = null
    this._onNoPath = null
    this._onFleeSuccess = null
    this._noPathStreak = 0
    /** @private @type {'BREAK_CONTACT' | 'STABILIZE' | 'RECOVER'} */
    this._fleePhase = FLEE_PHASES.BREAK_CONTACT
    /** @private @type {number} */
    this._fleePhaseSince = 0
    /** @private @type {{ planId: number, createdAt: number, goal: { x:number, y:number, z:number, range:number }, phaseAtCreate: string, reason: string, startNearest: number | null } | null} */
    this._fleePlan = null
    /** @private @type {number} */
    this._fleePlanSeq = 0
    /** @private @type {number} */
    this._lastFleeReplanAt = 0
    /** @private @type {number} */
    this._lastCombinedPressure = 0
    /** @private @type {number} epoch ms when exit preconditions became continuously safe (0 = not armed) */
    this._fleeExitStableSince = 0
    /** @private @type {number} reserved flee direction XZ (normalized), reset on spawn/end flee */
    this._fleeDirectionNx = 0
    /** @private @type {number} */
    this._fleeDirectionNz = 0
    this._healController = new HealController({
      bot: this._bot,
      bus: this._bus,
      config: this._config,
      getFleeSafeHpThreshold,
      findBestFoodItem,
      findBestHealPotion,
      isSplashLikePotion,
      equipBestWeapon,
      sleep,
      getMsSinceLastFleeNav: () => Date.now() - this._lastFleeNavAt,
      isStillInFlee: () => this._brain.state.getState() === CoreStates.FLEE,
      emitFleeNav: () => this._emitFleeNav(),
      emitFleeNavRandom: () => this._emitFleeNavRandom()
    })
  }

  /** @private */
  _clearFleeWatchdog () {
    if (this._fleeWatchdogTimer != null) {
      try {
        clearTimeout(this._fleeWatchdogTimer)
      } catch (_) {}
      this._fleeWatchdogTimer = null
    }
  }

  /**
   * @private
   * @param {object} detail
   */
  _logFleeEndDecision (detail) {
    const hp = Number(this._bot.health)
    const maxHp = Number(this._bot.maxHealth) > 0 ? Number(this._bot.maxHealth) : 20
    const threshold = getFleeSafeHpThreshold(this._bot, this._config)
    const line = {
      msg: 'flee end decision',
      ...detail,
      hp,
      maxHp,
      safeHpThreshold: threshold,
      hpVsTarget: `${hp}/${maxHp} (need >= ${threshold} to exit by HP)`
    }
    try {
      this._brain.log.info('[CombatSystem]', JSON.stringify(line))
    } catch (_) {
      console.log('[CombatSystem]', line)
    }
  }

  /** @private */
  _unregisterFleeTask () {
    if (!this._fleeTaskRegistered) return
    this._brain.scheduler.unregister(FLEE_TICK_TASK)
    this._fleeTaskRegistered = false
  }

  /** @private */
  _setFleePhase (next) {
    if (this._fleePhase === next) return
    this._fleePhase = next
    this._fleePhaseSince = Date.now()
    try {
      this._brain.log.debug('[CombatSystem] flee phase ->', next)
    } catch (_) {}
  }

  /** @private */
  _resolveFleePhase ({ nearest, far, elapsedMs, pressure }) {
    const breakContactBlocks = Math.max(4, Number(this._config.combatFleeBreakContactBlocks) || 9)
    const recoverThreatBlocks = Math.max(
      breakContactBlocks + 2,
      Number(this._config.combatFleeRecoverThreatBlocks) || 18
    )
    const stabilizeMinMs = Math.max(0, Number(this._config.combatFleeStabilizeMinMs) || 2200)
    if (pressure?.immediateDanger || (nearest != null && nearest <= breakContactBlocks)) return FLEE_PHASES.BREAK_CONTACT
    if (elapsedMs < stabilizeMinMs) return FLEE_PHASES.STABILIZE
    if (pressure?.safeToRecover || far || nearest == null || nearest >= recoverThreatBlocks) return FLEE_PHASES.RECOVER
    return FLEE_PHASES.STABILIZE
  }

  /** @private */
  _isEmergencyReplanReason (reason) {
    return (
      reason === FLEE_REPLAN_REASONS.NO_PATH ||
      reason === FLEE_REPLAN_REASONS.PRESSURE_SPIKE ||
      reason === FLEE_REPLAN_REASONS.DISTANCE_COLLAPSE
    )
  }

  /** @private */
  _buildRandomFleeGoal () {
    if (!this._bot.entity?.position) return null
    const pos = this._bot.entity.position
    const angle = Math.random() * Math.PI * 2
    const navBoost = Math.max(4, Math.min(24, Number(this._config.combatFleeNavDistance) || 12))
    const arriveR = Math.min(2.5, Math.max(1, Number(this._config.combatFleeGoalArrivalRange) || 1.5))
    return {
      x: pos.x + Math.cos(angle) * navBoost,
      y: pos.y,
      z: pos.z + Math.sin(angle) * navBoost,
      range: arriveR
    }
  }

  /** @private */
  _dispatchFleeGoal (goal) {
    if (!goal) return
    // Ускоряем pathfinder на время FLEE — короткие цели не требуют долгого A*
    try {
      if (this._bot.pathfinder) {
        this._bot.pathfinder.thinkTimeout = 1500
        this._bot.pathfinder.tickTimeout = 45
      }
    } catch (_) {}
    this._bus.emit(NavEvents.GOTO, {
      kind: 'near',
      x: goal.x,
      y: goal.y,
      z: goal.z,
      range: goal.range
    })
    this._lastFleeNavAt = Date.now()
    this._fleeNavLocked = true
    setTimeout(() => {
      this._fleeNavLocked = false
    }, 2500)
  }

  /** @private */
  _replanFlee ({ reason, phase, nearest, preferRandom, force }) {
    if (this._brain.state.getState() !== CoreStates.FLEE) return false
    const now = Date.now()
    const minReplanMs = Math.max(300, Number(this._config.combatFleePlanMinReplanMs) || 1200)
    if (!force && !this._isEmergencyReplanReason(reason) && now - this._lastFleeReplanAt < minReplanMs) {
      return false
    }
    const goal = preferRandom ? this._buildRandomFleeGoal() : computeFleeGoal(this._bot, this._memory, this._config)
    if (!goal) return false

    const nextPlanId = this._fleePlanSeq + 1
    this._fleePlanSeq = nextPlanId
    this._fleePlan = {
      planId: nextPlanId,
      createdAt: now,
      goal,
      phaseAtCreate: phase || this._fleePhase,
      reason: String(reason || FLEE_REPLAN_REASONS.TIMEOUT),
      startNearest: Number.isFinite(Number(nearest)) ? Number(nearest) : null
    }
    this._lastFleeReplanAt = now
    try {
      this._brain.log.info('[CombatSystem] flee replan', JSON.stringify({
        reason: this._fleePlan.reason,
        planId: this._fleePlan.planId,
        phase: this._fleePlan.phaseAtCreate,
        nearest: this._fleePlan.startNearest
      }))
    } catch (_) {}
    this._dispatchFleeGoal(goal)
    return true
  }

  /** @private */
  _shouldReplanFlee ({ pressure, nearest, now }) {
    const emergencyDistance = Math.max(
      4,
      Number(this._config.combatFleeEmergencyReplanDistance) || Number(this._config.combatFleeBreakContactBlocks) || 9
    )
    if (nearest != null && nearest <= emergencyDistance && this._fleePhase !== FLEE_PHASES.BREAK_CONTACT) {
      return FLEE_REPLAN_REASONS.DISTANCE_COLLAPSE
    }
    const spikeDelta = Math.max(0.35, Number(this._config.combatFleePressureSpikeDelta) || 1.1)
    if (
      Number.isFinite(this._lastCombinedPressure) &&
      pressure.combinedPressure - this._lastCombinedPressure >= spikeDelta &&
      pressure.immediateDanger
    ) {
      return FLEE_REPLAN_REASONS.PRESSURE_SPIKE
    }

    if (!this._fleePlan) return FLEE_REPLAN_REASONS.TIMEOUT
    const planAge = now - this._fleePlan.createdAt
    const holdMs = Math.max(800, Number(this._config.combatFleePlanHoldMs) || 2600)
    const maxMs = Math.max(holdMs + 500, Number(this._config.combatFleePlanMaxMs) || 7000)
    if (planAge >= maxMs) return FLEE_REPLAN_REASONS.PLAN_TTL_EXCEEDED

    if (planAge < holdMs) return null
    const baseNearest = this._fleePlan.startNearest
    const progressEnough = (
      nearest == null ||
      baseNearest == null ||
      (Number.isFinite(nearest) && nearest - baseNearest >= 1.2)
    )
    if (!progressEnough) return FLEE_REPLAN_REASONS.TIMEOUT
    return null
  }

  /** @private */
  _endFlee (reason) {
    this._clearFleeWatchdog()
    this._unregisterFleeTask()
    this._fleeAnnounced = false
    this._fleeStartedAt = 0
    this._fleePhase = FLEE_PHASES.BREAK_CONTACT
    this._fleePhaseSince = 0
    this._fleePlan = null
    this._lastFleeReplanAt = 0
    this._lastCombinedPressure = 0
    this._fleeNavLocked = false
    this._noPathStreak = 0
    this._healController.reset()
    this._fleeExitStableSince = 0
    this._fleeDirectionNx = 0
    this._fleeDirectionNz = 0
    // Восстанавливаем нормальные таймауты pathfinder после FLEE
    try {
      if (this._bot.pathfinder) {
        this._bot.pathfinder.thinkTimeout = Number(this._config.pathThinkTimeoutMs) || 24000
        this._bot.pathfinder.tickTimeout = Number(this._config.pathTickTimeoutMs) || 150
      }
    } catch (_) {}
    if (this._onNoPath) {
      try { this._bus.off(NavEvents.PATH_RESULT, this._onNoPath) } catch (_) {}
      this._onNoPath = null
    }
    if (this._onFleeSuccess) {
      try { this._bus.off(NavEvents.PATH_RESULT, this._onFleeSuccess) } catch (_) {}
      this._onFleeSuccess = null
    }
    try {
      this._brain.log.debug('[CombatSystem] flee end', reason)
    } catch (_) {}
  }

  /** @private */
  _pickReengageName () {
    for (const t of this._memory.getCurrentThreats()) {
      const e = this._bot.entities[t.id]
      if (!e?.position || !this._bot.entity?.position) continue
      if ((e.health != null && e.health <= 0) || e === this._bot.entity) continue
      if (this._bot.partyIFF && e.type === 'player') {
        if (this._bot.partyIFF.isPartyUsername?.(e.username || '')) continue
      }
      const d = this._bot.entity.position.distanceTo(e.position)
      if (d < 48 && t.name) return String(t.name)
    }
    const la = this._memory.getLastAttacker()
    if (la?.username && la.distance < 40) return la.username

    const R = 48
    const myPos = this._bot.entity?.position
    if (!myPos) return ''
    let best = null
    let bestD = Infinity
    for (const e of Object.values(this._bot.entities || {})) {
      if (!e || e === this._bot.entity || e.id === this._bot.entity?.id) continue
      if (e.health != null && e.health <= 0) continue
      if (!e.position) continue
      if (e.type !== 'player' && e.type !== 'mob' && e.type !== 'hostile') continue
      if (e.type === 'player' && this._bot.partyIFF) {
        if (typeof this._bot.partyIFF.isPartyUsername === 'function') {
          if (this._bot.partyIFF.isPartyUsername(e.username || '')) continue
        }
        if (typeof this._bot.partyIFF.isDefenseThreatEntity === 'function') {
          if (!this._bot.partyIFF.isDefenseThreatEntity(e, {})) continue
        }
      }
      const d = myPos.distanceTo(e.position)
      if (!Number.isFinite(d) || d >= R) continue
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    if (best) {
      const label = reengageLabelFromEntity(best)
      if (label) return label
    }
    return ''
  }

  /** @private */
  _emitFleeNav () {
    if (this._fleePlan?.goal) {
      this._dispatchFleeGoal(this._fleePlan.goal)
      return
    }
    void this._replanFlee({
      reason: FLEE_REPLAN_REASONS.TIMEOUT,
      phase: this._fleePhase,
      nearest: null,
      preferRandom: false,
      force: true
    })
  }

  _emitFleeNavRandom () {
    void this._replanFlee({
      reason: FLEE_REPLAN_REASONS.TIMEOUT,
      phase: this._fleePhase,
      nearest: null,
      preferRandom: true,
      force: true
    })
  }

  /** @private */
  _tryConsumeHeal () {
    const thr = getFleeSafeHpThreshold(this._bot, this._config)
    const hp = Number(this._bot.health)
    if (!Number.isFinite(hp)) return
    this._healController.tryStart({ hpNeedsHeal: hp < thr })
  }

  /** @private */
  _fleeTick () {
    if (this._brain.state.getState() !== CoreStates.FLEE) {
      this._unregisterFleeTask()
      return
    }
    const fleeElapsed = this._fleeStartedAt > 0 ? Date.now() - this._fleeStartedAt : 0
    if (fleeElapsed > 30000) {
      const hp = Number(this._bot.health)
      const critHp = Number(this._config.combatFleeCriticalHp) || 6
      if (hp > critHp) {
        this._logFleeEndDecision({ reason: 'max_flee_time', nextState: 'IDLE' })
        this._bus.emit(NavEvents.STOP, { reason: 'flee_max_time' })
        this._endFlee('max_time')
        this._brain.state.transition(CoreStates.IDLE)
        return
      }
    }
    if (this._healController.isBusy()) return

    // Сначала проверяем хил — даже пока бежим
    const hasHeal = hasConsumableHeal(this._bot, this._config)
    const minMs = Number(this._config.combatFleeMinMsNoHeal) || 8000
    const clearBlocks = Number(this._config.combatFleeClearThreatBlocks) || 14
    const elapsed = this._fleeStartedAt > 0 ? Date.now() - this._fleeStartedAt : 0
    const { far, nearest } = threatDistanceSummary(this._bot, this._memory, clearBlocks)
    const pressure = evaluateThreatPressure(this._bot, this._memory, this._config)
    const nextPhase = this._resolveFleePhase({ nearest, far, elapsedMs: elapsed, pressure })
    this._setFleePhase(nextPhase)
    const now = Date.now()
    const canHealNow =
      this._fleePhase !== FLEE_PHASES.BREAK_CONTACT &&
      pressure.healWindowSafe
    this._healController.observeSafetyTick(canHealNow)

    if (
      this._fleePhase !== FLEE_PHASES.BREAK_CONTACT &&
      canHealNow &&
      !isHpAtOrAboveFleeSafe(this._bot, this._config)
    ) {
      this._tryConsumeHeal()
    }

    const replanReason = this._shouldReplanFlee({ pressure, nearest, now })
    if (replanReason) {
      const preferRandom =
        replanReason === FLEE_REPLAN_REASONS.NO_PATH ||
        replanReason === FLEE_REPLAN_REASONS.TIMEOUT ||
        replanReason === FLEE_REPLAN_REASONS.DISTANCE_COLLAPSE
      void this._replanFlee({
        reason: replanReason,
        phase: this._fleePhase,
        nearest,
        preferRandom,
        force: this._isEmergencyReplanReason(replanReason)
      })
    } else if (!this._fleeNavLocked && this._fleePlan?.goal) {
      // Keep owning the same retreat plan to reduce nav:goto churn.
      this._dispatchFleeGoal(this._fleePlan.goal)
    }

    this._lastCombinedPressure = pressure.combinedPressure

    const hysteresisMs = Math.max(400, Math.min(6000, Number(this._config.combatFleeExitHysteresisMs) || 1800))
    const wantHpExit =
      this._fleePhase === FLEE_PHASES.RECOVER &&
      pressure.safeToExitFlee &&
      isHpAtOrAboveFleeSafe(this._bot, this._config)
    const wantNoHealExit =
      !hasHeal &&
      this._fleePhase !== FLEE_PHASES.BREAK_CONTACT &&
      (elapsed >= minMs || far) &&
      pressure.safeToExitFlee
    const exitCandidate = wantHpExit || wantNoHealExit
    if (!exitCandidate) {
      this._fleeExitStableSince = 0
    } else if (this._fleeExitStableSince === 0) {
      this._fleeExitStableSince = now
    }
    const stableExitOk = exitCandidate && now - this._fleeExitStableSince >= hysteresisMs

    if (stableExitOk && wantHpExit) {
      const threatName = this._pickReengageName()
      this._logFleeEndDecision({
        reason: 'hp_safe',
        fleePhase: this._fleePhase,
        hasHeal,
        elapsedMs: elapsed,
        exitHysteresisMs: hysteresisMs,
        exitStableMs: now - this._fleeExitStableSince,
        nearestThreatDist: nearest,
        nearbyThreatCount: pressure.nearbyThreatCount,
        immediateDangerScore: pressure.immediateDangerScore,
        recentAggroScore: pressure.recentAggroScore,
        combinedPressure: pressure.combinedPressure,
        threatClearFar: far,
        minMsNoHeal: minMs,
        clearThreatBlocks: clearBlocks,
        nextState: threatName ? 'COMBAT' : 'IDLE'
      })
      this._bus.emit(NavEvents.STOP, { reason: 'flee_recovered' })
      this._endFlee('recovered')
      if (threatName) {
        this._brain.state.transition(CoreStates.COMBAT, { entityName: threatName })
        const at = Date.now()
        this._bus.emit(CombatEvents.ENGAGE_ENTITY, {
          entityName: threatName,
          strategy: 'defensive',
          at
        })
      } else {
        const last = this._brain.getLastMode()
        const at = Date.now()
        if (last) {
          if (last.type === 'defend_entity') this._bus.emit(DefendEvents.DEFEND_ENTITY, { params: last.params || {}, at })
          else if (last.type === 'defend_point') this._bus.emit(DefendEvents.DEFEND_POINT, { params: last.params || {}, at })
          else if (last.type === 'patrol') this._bus.emit(DefendEvents.PATROL_MODE, { params: last.params || {}, at })
          else if (last.type === 'follow' && last.targetUsername) this._bus.emit(MovementEvents.SET_FOLLOW, { targetUsername: last.targetUsername, at })
          else if (last.type === 'come' && last.targetUsername) this._bus.emit(MovementEvents.SET_COME, { targetUsername: last.targetUsername, at })
          else if (last.type === 'guard' && last.targetUsername) this._bus.emit(CombatEvents.SET_GUARD, { targetUsername: last.targetUsername, at })
        }
        this._brain.state.transition(CoreStates.IDLE)
      }
      return
    }

    if (stableExitOk && wantNoHealExit && !wantHpExit) {
      this._logFleeEndDecision({
        reason: 'no_heal_items_min_time_or_clear',
        fleePhase: this._fleePhase,
        hasHeal: false,
        elapsedMs: elapsed,
        exitHysteresisMs: hysteresisMs,
        exitStableMs: now - this._fleeExitStableSince,
        nearestThreatDist: nearest,
        nearbyThreatCount: pressure.nearbyThreatCount,
        immediateDangerScore: pressure.immediateDangerScore,
        recentAggroScore: pressure.recentAggroScore,
        combinedPressure: pressure.combinedPressure,
        threatClearFar: far,
        minMsNoHeal: minMs,
        clearThreatBlocks: clearBlocks,
        nextState: 'IDLE'
      })
      this._bus.emit(NavEvents.STOP, { reason: 'flee_no_heal_escape' })
      this._endFlee('no_heal_escape')
      this._brain.state.transition(CoreStates.IDLE)
      return
    }
  }

  /** @private */
  async _enterFlee () {
    if (this._brain.state.getState() === CoreStates.FLEE) return
    if (!isCombatSessionActive()) return
    if (this._brain.isFleeCooldown()) return

    /** FSM first: defend.js `pathfinderYieldedToCombat` stays true while FLEE even after `stopAttack` clears the session. */
    this._brain.state.transition(CoreStates.FLEE, { reason: 'low_hp' })
    this._fleeStartedAt = Date.now()
    this._fleePhase = FLEE_PHASES.BREAK_CONTACT
    this._fleePhaseSince = this._fleeStartedAt
    this._fleePlan = null
    this._lastFleeReplanAt = 0
    let seedPressure = 0
    try {
      seedPressure = evaluateThreatPressure(this._bot, this._memory, this._config).combinedPressure
    } catch (_) {}
    this._lastCombinedPressure = Number.isFinite(seedPressure) ? seedPressure : 0
    this._fleeExitStableSince = 0
    this._fleeNavLocked = false
    this._lastFleeNavAt = 0
    this._healController.reset()
    if (!this._onNoPath) {
      this._onNoPath = (payload) => {
        if (this._brain.state.getState() !== CoreStates.FLEE) return
        if (payload?.status !== 'noPath' && payload?.status !== 'timeout') return
        this._noPathStreak++
        this._fleeNavLocked = false
        const reason = payload?.status === 'timeout'
          ? FLEE_REPLAN_REASONS.TIMEOUT
          : FLEE_REPLAN_REASONS.NO_PATH
        void this._replanFlee({
          reason,
          phase: this._fleePhase,
          nearest: null,
          preferRandom: true,
          force: true
        })
        if (this._noPathStreak >= 3) {
          this._noPathStreak = 0
          try {
            this._bot.setControlState('jump', true)
            setTimeout(() => {
              try { this._bot.setControlState('jump', false) } catch (_) {}
            }, 400)
          } catch (_) {}
        }
      }
      this._bus.on(NavEvents.PATH_RESULT, this._onNoPath)
    }

    this._clearFleeWatchdog()
    this._fleeWatchdogTimer = setTimeout(() => {
      this._fleeWatchdogTimer = null
      if (this._brain.state.getState() !== CoreStates.FLEE) return
      try { this._brain.log.warn('[CombatSystem] FLEE watchdog (15s): forcing IDLE, cooldown 8s') } catch (_) {}
      this._brain.setFleeCooldown(8000)
      try { this._bus.emit(NavEvents.STOP, { reason: 'flee_watchdog' }) } catch (_) {}
      this._endFlee('watchdog')
      try { this._brain.state.transition(CoreStates.IDLE) } catch (_) {}
    }, 15000)

    // Продлеваем watchdog при каждом успешном nav:path_result
    if (!this._onFleeSuccess) {
      this._onFleeSuccess = (payload) => {
        if (this._brain.state.getState() !== CoreStates.FLEE) return
        if (payload?.status !== 'success') return
        this._clearFleeWatchdog()
        this._fleeWatchdogTimer = setTimeout(() => {
          this._fleeWatchdogTimer = null
          if (this._brain.state.getState() !== CoreStates.FLEE) return
          try { this._brain.log.warn('[CombatSystem] FLEE watchdog (8s no progress): forcing IDLE') } catch (_) {}
          this._brain.setFleeCooldown(8000)
          try { this._bus.emit(NavEvents.STOP, { reason: 'flee_watchdog' }) } catch (_) {}
          this._endFlee('watchdog')
          try { this._brain.state.transition(CoreStates.IDLE) } catch (_) {}
        }, 8000)
      }
      this._bus.on(NavEvents.PATH_RESULT, this._onFleeSuccess)
    }

    if (!this._fleeAnnounced) {
      this._fleeAnnounced = true
      const speak = this._voice?.speak
      if (typeof speak === 'function') {
        void speak('Мало здоровья — отступаю и лечусь.').catch(() => {})
      }
    }

    await stopAttack(this._bot, this._voice, { silent: true })

    this._emitFleeNav()

    if (!this._fleeTaskRegistered) {
      const ticks = Number(this._config.combatFleeRetickTicks) || 12
      this._brain.scheduler.registerPeriodic(ticks, this._fleeTick, { id: FLEE_TICK_TASK })
      this._fleeTaskRegistered = true
    }
  }

  /** @private */
  _onHealth () {
    if (this._brain.state.getState() === CoreStates.FLEE) {
      // In FLEE healing is coordinated by `_fleeTick` with threat-distance gates.
      // Triggering consume directly on every health update can spam/cancel consume
      // while the bot is still under close pressure.
      return
    }
    if (!isCombatSessionActive()) return
    const pressure = evaluateThreatPressure(this._bot, this._memory, this._config)
    const hardHpTrigger = shouldFleeByHp(this._bot, this._config)
    const riskTrigger = shouldFleeByRisk(this._bot, this._config, pressure)
    if (!hardHpTrigger && !riskTrigger) return
    if (riskTrigger && !hardHpTrigger) {
      try {
        this._brain.log.debug('[CombatSystem] flee risk trigger', JSON.stringify({
          retreatScore: pressure.retreatScore,
          retreatScoreThreshold: pressure.retreatScoreThreshold,
          combinedPressure: pressure.combinedPressure,
          nearestDistance: pressure.nearestDistance,
          nearbyThreatCount: pressure.nearbyThreatCount
        }))
      } catch (_) {}
    }
    void this._enterFlee().catch(() => {})
  }

  /** @private */
  _onEngage (payload) {
    const entityName = payload && payload.entityName != null ? String(payload.entityName) : ''
    const rawId = payload && payload.entityId
    const entityId = rawId != null && Number.isFinite(Number(rawId)) ? Number(rawId) : undefined
    if (!entityName && entityId == null) return
    const strategy = payload && payload.strategy != null ? String(payload.strategy) : 'aggressive'
    void attackEntity(this._bot, this._voice, { entityName, strategy, entityId }).catch(() => {})
  }

  /** @private */
  _onStop () {
    if (this._brain.state.getState() === CoreStates.FLEE) {
      void stopAttack(this._bot, this._voice, { silent: true }).catch(() => {})
      this._bus.emit(NavEvents.STOP, { reason: 'stop_attack' })
      this._endFlee('stop_attack')
      this._brain.state.transition(CoreStates.IDLE)
      return
    }
    if (!isCombatSessionActive()) {
      void stopAttack(this._bot, this._voice, { silent: true }).catch(() => {})
      return
    }
    void stopAttack(this._bot, this._voice).catch(() => {})
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bus.on(CombatEvents.ENGAGE_ENTITY, this._onEngage)
    this._bus.on(CombatEvents.STOP_ATTACK, this._onStop)
    this._bot.on('health', this._onHealth)
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._bus.off(CombatEvents.ENGAGE_ENTITY, this._onEngage)
    this._bus.off(CombatEvents.STOP_ATTACK, this._onStop)
    this._bot.removeListener('health', this._onHealth)
    if (this._brain.state.getState() === CoreStates.FLEE) {
      try {
        this._bus.emit(NavEvents.STOP, { reason: 'combat_system_destroy' })
      } catch (_) {}
      this._endFlee('destroy')
      try {
        this._brain.state.transition(CoreStates.IDLE)
      } catch (_) {}
    } else {
      this._endFlee('destroy')
    }
  }
}

module.exports = { CombatSystem }
