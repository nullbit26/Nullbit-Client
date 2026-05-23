'use strict'

const { CoreEvents, CombatEvents, ResourceEvents, AwarenessEvents } = require('../core/EventRegistry')
const { CoreStates } = require('../core/StateManager')
const { isCombatSessionActive } = require('../attackEntity')
const { evaluateThreatPressure } = require('../combat/flee/evaluateThreatPressure')

/** How long to wait for combat to finish before giving up and switching to flee (ms) */
const COMBAT_WAIT_TIMEOUT_MS = 30_000
/** Poll interval while waiting for combat to end (ms) */
const COMBAT_POLL_MS = 500
/** Cooldown after combat ends before resuming gather (ms) */
const POST_COMBAT_COOLDOWN_MS = 1500

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * GatherGuardSystem — bridges GATHER_PAUSED combat interrupts with CombatSystem.
 *
 * When gather is paused due to a threat:
 *   - If bot can win (enough HP, few threats) → emit ENGAGE_ENTITY, wait for combat to end, resume gather
 *   - If bot should flee → let CombatSystem handle FLEE naturally, resume gather after IDLE restored
 *
 * @typedef {Object} GatherGuardCtx
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/BotBrain').BotBrain} brain
 * @property {any} config
 * @property {import('./ResourceSystem').ResourceSystem} resourceSystem
 */
class GatherGuardSystem {
  /**
   * @param {GatherGuardCtx} ctx
   */
  constructor (ctx) {
    if (!ctx?.brain) throw new Error('[GatherGuardSystem] brain is required')
    if (!ctx?.resourceSystem) throw new Error('[GatherGuardSystem] resourceSystem is required')

    this._bot = ctx.bot
    this._brain = ctx.brain
    this._bus = ctx.brain.eventBus
    this._config = ctx.config
    this._rs = ctx.resourceSystem
    this._state = ctx.state || {} // mode tracking (follow/guard/gather)

    this._wired = false
    this._handling = false
    /** @private — prevents _onStateChanged from double-resuming when _handleCombatPause already called _resumeGather */
    this._resumeScheduled = false

    this._onGatherPaused = this._onGatherPaused.bind(this)
    this._onThreatDetected = this._onThreatDetected.bind(this)
    this._onStateChanged = this._onStateChanged.bind(this)
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bus.on(ResourceEvents.GATHER_PAUSED, this._onGatherPaused)
    this._bus.on(AwarenessEvents.THREAT_DETECTED, this._onThreatDetected)
    this._bus.on(CoreEvents.STATE_CHANGED, this._onStateChanged)
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._bus.off(ResourceEvents.GATHER_PAUSED, this._onGatherPaused)
    this._bus.off(AwarenessEvents.THREAT_DETECTED, this._onThreatDetected)
    this._bus.off(CoreEvents.STATE_CHANGED, this._onStateChanged)
  }

  // ---------------------------------------------------------------------------

  /** @private */
  _onThreatDetected (_payload) {
    // If gather is active and we aren't already handling — pause gather and react
    if (this._handling) return
    // Do NOT react to threats when in follow or guard mode (manual control)
    if (this._state.mode === 'follow' || this._state.mode === 'guard') return
    if (!this._rs.isGathering()) return
    const state = this._brain.state.getState()
    if (state === CoreStates.COMBAT || state === CoreStates.FLEE) return
    this._log('threat detected while gathering — pausing and reacting')
    this._rs.pauseGather('HOSTILE_CONTACT')
    // pauseGather will emit GATHER_PAUSED which triggers _onGatherPaused below
  }

  /** @private */
  _onGatherPaused (payload) {
    if (this._handling) return
    const reason = payload?.reason || ''
    // Only handle combat-triggered pauses
    if (!reason.includes('HOSTILE') && !reason.includes('COMBAT')) return
    this._handling = true
    this._resumeScheduled = false
    this._handleCombatPause().finally(() => { this._handling = false })
  }

  /** @private */
  async _handleCombatPause () {
    try {
      await sleep(200) // let CombatSystem react first (health event → FLEE transition)
      if (!this._brain) return

      const state = this._brain.state.getState()
      const memory = this._brain.memory

      if (state === CoreStates.FLEE) {
        // CombatSystem already handling flee — just wait for IDLE then resume
        this._log('threat detected during gather — fleeing, will resume after')
        await this._waitForIdle(COMBAT_WAIT_TIMEOUT_MS)
        await sleep(POST_COMBAT_COOLDOWN_MS)
        this._resumeScheduled = true
        this._resumeGather()
        return
      }

      // Bot is not fleeing — decide: fight or flee?
      const pressure = this._getOrBuildPressure(memory)

      const nearestThreat = this._findNearestThreat()
      const isCreeper = nearestThreat && /creeper/i.test(nearestThreat.name || nearestThreat.displayName || '')
      const threatCount = pressure?.nearbyThreatCount || 0
      const hp = Number(this._bot.health)

      // SURVIVAL MODE: simple rules for gather — prioritize safety over complex scoring
      const survivalThreatCount = Math.max(2, Number(this._config?.gatherGuardSurvivalThreatCount) || 3)
      const survivalLowHp = Math.max(2, Number(this._config?.gatherGuardSurvivalLowHp) || 8)
      if (threatCount >= survivalThreatCount) {
        this._log(`SURVIVAL MODE: ${threatCount} threats detected — immediate flee`)
        this._bus.emit(CombatEvents.FLEE_START, { reason: 'gather_survival_many_threats', at: Date.now() })
        await this._waitForIdle(COMBAT_WAIT_TIMEOUT_MS)
        await sleep(POST_COMBAT_COOLDOWN_MS)
        this._resumeScheduled = true
        this._resumeGather()
        return
      }

      if (hp < survivalLowHp) {
        this._log(`SURVIVAL MODE: low HP (${Math.round(hp)}) — immediate flee`)
        this._bus.emit(CombatEvents.FLEE_START, { reason: 'gather_survival_low_hp', at: Date.now() })
        await this._waitForIdle(COMBAT_WAIT_TIMEOUT_MS)
        await sleep(POST_COMBAT_COOLDOWN_MS)
        this._resumeScheduled = true
        this._resumeGather()
        return
      }

      if (!isCreeper && this._shouldFight(pressure, nearestThreat)) {
        const threat = nearestThreat
        if (threat) {
          const name = threat.username || threat.name || threat.displayName || String(threat.id ?? '')
          if (name) {
            this._log(`fighting threat: ${name} (threats=${pressure?.nearbyThreatCount}, hp=${Math.round(this._bot.health)}/${Math.round(this._bot.maxHealth)})`)
            this._brain.state.transition(CoreStates.COMBAT, { entityName: name })
            this._bus.emit(CombatEvents.ENGAGE_ENTITY, {
              entityName: name,
              entityId: typeof threat.id === 'number' ? threat.id : undefined,
              strategy: 'defensive',
              at: Date.now()
            })
            // Wait for combat to finish — if timeout, flee instead
            const combatEnded = await this._waitForCombatEnd(COMBAT_WAIT_TIMEOUT_MS)
            if (!combatEnded) {
              this._log('combat timeout — switching to flee')
              this._bus.emit(CombatEvents.STOP_ATTACK, { reason: 'gather_combat_timeout', at: Date.now() })
              this._bus.emit(CombatEvents.FLEE_START, { reason: 'gather_combat_timeout', at: Date.now() })
              await this._waitForIdle(COMBAT_WAIT_TIMEOUT_MS)
            }
            await sleep(POST_COMBAT_COOLDOWN_MS)
            this._resumeScheduled = true
            this._resumeGather()
            return
          }
        }
      }

      // Creeper or can't fight — trigger flee via CombatSystem
      if (isCreeper) {
        this._log('CREEPER detected — fleeing immediately')
      } else {
        this._log('threat detected — triggering flee before resuming gather')
      }
      this._bus.emit(CombatEvents.FLEE_START, { reason: isCreeper ? 'creeper' : 'gather_threat', at: Date.now() })
      await this._waitForIdle(COMBAT_WAIT_TIMEOUT_MS)
      await sleep(POST_COMBAT_COOLDOWN_MS)
      this._resumeScheduled = true
      this._resumeGather()
    } catch (e) {
      try { this._brain.log.warn('[GatherGuardSystem] error in _handleCombatPause:', e?.message) } catch (_) {}
    }
  }

  /**
   * Decide if bot should engage rather than flee.
   * @private
   * @param {ReturnType<typeof evaluateThreatPressure> | null} pressure
   */
  _shouldFight (pressure, nearestThreat) {
    const hp = Number(this._bot.health)
    const max = Number(this._bot.maxHealth) > 0 ? Number(this._bot.maxHealth) : 20
    const hpRatio = Number.isFinite(hp) && max > 0 ? hp / max : 0

    const fightMinHpRatio   = Math.max(0.3, Number(this._config?.gatherGuardFightMinHpRatio)   || 0.60)
    const fightMaxEngageDist = Math.max(6,   Number(this._config?.gatherGuardFightMaxEngageDist) || 12)
    const fightMaxThreats    = Math.max(1,   Number(this._config?.gatherGuardFightMaxThreats)    || 2)

    if (hpRatio < fightMinHpRatio) return false

    // Don't break gather for distant threats — only engage if actually close
    if (nearestThreat && this._bot.entity?.position) {
      const d = this._bot.entity.position.distanceTo(nearestThreat.position)
      if (d > fightMaxEngageDist) return false
    }

    if (!pressure) return hpRatio >= fightMinHpRatio

    if (pressure.shouldEnterFleeByRisk) return false
    if (pressure.nearbyThreatCount > fightMaxThreats) return false

    return true
  }

  /**
   * Find the nearest hostile entity.
   * @private
   */
  _findNearestThreat () {
    // Use PartyIFFSystem if available
    if (this._bot.partyIFF && typeof this._bot.partyIFF.listThreatsWithin === 'function') {
      const threats = this._bot.partyIFF.listThreatsWithin(24)
      if (threats.length > 0) return threats[0].entity
    }

    // Fallback: scan entities for hostile mobs near bot (players excluded — no IFF context)
    const pos = this._bot.entity?.position
    if (!pos || !this._bot.entities) return null
    let best = null; let bestDist = 24
    for (const e of Object.values(this._bot.entities)) {
      if (!e?.position || e === this._bot.entity) continue
      if (e.health != null && e.health <= 0) continue
      if (e.type !== 'mob' && e.type !== 'hostile') continue
      const d = pos.distanceTo(e.position)
      if (d < bestDist) { bestDist = d; best = e }
    }
    return best
  }

  /**
   * Wait until combat session ends or timeout.
   * @private
   */
  async _waitForCombatEnd (maxMs) {
    const deadline = Date.now() + maxMs
    const SESSION_GONE_GRACE_MS = 800
    let sessionGoneAt = null

    while (Date.now() < deadline) {
      const s = this._brain.state.getState()
      if (s !== CoreStates.COMBAT && s !== CoreStates.FLEE) return true

      const sessionActive = isCombatSessionActive()
      if (!sessionActive) {
        if (sessionGoneAt === null) {
          sessionGoneAt = Date.now()
        } else if (Date.now() - sessionGoneAt >= SESSION_GONE_GRACE_MS) {
          if (this._brain.state.getState() === CoreStates.COMBAT) {
            this._log('combat session ended but state stuck in COMBAT — forcing IDLE')
            try { this._brain.state.transition(CoreStates.IDLE) } catch (_) {}
          }
          return true
        }
      } else {
        sessionGoneAt = null
      }

      await sleep(COMBAT_POLL_MS)
    }
    return false
  }

  /**
   * Wait until core state returns to IDLE (not COMBAT/FLEE).
   * @private
   */
  async _waitForIdle (maxMs) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      const s = this._brain.state.getState()
      if (s !== CoreStates.COMBAT && s !== CoreStates.FLEE) break
      await sleep(COMBAT_POLL_MS)
    }
  }

  /**
   * Resume gather if bot is IDLE, RecoveryHold released, and not already gathering.
   * If RecoveryHold is still active, schedules a re-check via RecoveryHoldEvents.EXIT.
   * @private
   */
  _resumeGather () {
    if (!this._brain) return
    const s = this._brain.state.getState()
    if (s === CoreStates.COMBAT || s === CoreStates.FLEE) {
      this._log('still in combat/flee after wait — skipping resume')
      return
    }
    if (this._rs.isGathering()) return // already resumed somehow
    // Read resource from interruptedTask so we resume the correct job type
    const resource = this._brain.taskState?.interruptedTask?.resource
    if (!resource) {
      this._log('no interruptedTask resource — skipping resume')
      return
    }
    // If RecoveryHold is still active, wait for it to release before starting
    if (this._brain.recoveryHoldSystem?.isActive?.()) {
      this._log('RecoveryHold still active — deferring gather resume until EXIT')
      const { RecoveryHoldEvents } = require('../core/EventRegistry')
      const onExit = () => {
        this._bus.off(RecoveryHoldEvents.EXIT, onExit)
        if (this._rs.isGathering()) return
        const s2 = this._brain.state.getState()
        if (s2 === CoreStates.COMBAT || s2 === CoreStates.FLEE) return
        const res2 = this._brain.taskState?.interruptedTask?.resource
        if (!res2) return
        this._log(`resuming gather after RecoveryHold exit (resource=${res2})`)
        this._rs.startGather(res2)
      }
      this._bus.on(RecoveryHoldEvents.EXIT, onExit)
      return
    }
    this._log(`resuming gather after combat (resource=${resource})`)
    this._rs.startGather(resource)
  }

  /**
   * Resume gather when state returns to IDLE after COMBAT or FLEE.
   * Only fires on COMBAT→IDLE or FLEE→IDLE transitions to avoid false triggers
   * (e.g. follow-stop, manual state resets).
   * @private
   */
  _onStateChanged (payload) {
    if (payload?.to !== CoreStates.IDLE) return
    // Only react to combat/flee → idle transitions
    if (payload?.from !== CoreStates.COMBAT && payload?.from !== CoreStates.FLEE) return
    if (this._handling) return
    if (this._resumeScheduled) return // _handleCombatPause already handling this
    if (this._rs.isGathering()) return
    const resource = this._brain.taskState?.interruptedTask?.resource
    if (!resource) return
    // Small delay so POST_FLEE RecoveryHold can register first
    setTimeout(() => {
      if (this._handling) return
      if (this._rs.isGathering()) return
      const s = this._brain.state.getState()
      if (s === CoreStates.COMBAT || s === CoreStates.FLEE) return
      this._resumeGather()
    }, POST_COMBAT_COOLDOWN_MS + 200)
  }

  /**
   * Returns a threat pressure snapshot.
   * Uses the cached DecisionContext from TacticalDecisionEngine (Phase 3) when it is
   * fresh enough (< 150 ms old). Falls back to a live evaluateThreatPressure call
   * so async handlers that run after awaits still get accurate data.
   *
   * @private
   * @param {import('../memory/OperationalMemory').OperationalMemory | null} memory
   */
  _getOrBuildPressure (memory) {
    const cached = this._brain.decisionContext
    if (cached && typeof cached.now === 'number' && (Date.now() - cached.now) < 150) {
      return cached // fresh enough — no extra work
    }
    return memory
      ? evaluateThreatPressure(this._bot, memory, this._config)
      : null
  }

  /** @private */
  _log (...args) {
    try { this._brain.log.info('[GatherGuardSystem]', ...args) } catch (_) {}
  }
}

module.exports = { GatherGuardSystem }
