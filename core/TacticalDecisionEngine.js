'use strict'

const { buildDecisionContext } = require('./decisionContext')
const { TacticalEvents } = require('./EventRegistry')

const TASK_ID = 'tactical_decision_engine_tick'
const TICK_INTERVAL = 1 // every physicsTick

/**
 * Phase 3 — TacticalDecisionEngine
 *
 * Single source of truth for threat/survival assessment.
 * Runs once per physics tick, builds an immutable {@link DecisionContext},
 * caches it on `brain.decisionContext`, and emits `tactical:context_updated`.
 *
 * All systems (SurvivalSystem, GatherGuardSystem, etc.) read the cached
 * context instead of calling evaluateThreatPressure() independently.
 *
 * Scorer weights (read-only, attached to context each tick):
 *   - threatScore    0..1  — how dangerous the situation is right now
 *   - survivalScore  0..1  — how urgently the bot needs to eat/heal
 *   - resourceScore  0..1  — how worthwhile it is to keep gathering
 */
class TacticalDecisionEngine {
  /**
   * @param {{ bot: import('mineflayer').Bot, brain: import('./BotBrain').BotBrain, config: any }} ctx
   */
  constructor ({ bot, brain, config }) {
    if (!brain) throw new Error('[TacticalDecisionEngine] brain is required')
    this._bot = bot
    this._brain = brain
    this._config = config
    this._wired = false
    this._tick = this._tick.bind(this)
    this._prevSnapshot = null
    this._lastScoreOutput = 0 // Throttle score output
    this._lastInvOutput = 0  // Throttle inventory output
    this._lastCombatOutput = 0 // Throttle combat output
    this._lastWatchdogOutput = 0 // Throttle watchdog output
    this._lastStatusOutput = 0 // Throttle status output
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._brain.scheduler.registerPeriodic(TICK_INTERVAL, this._tick, { id: TASK_ID, phase: 0 })
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._brain.scheduler.unregister(TASK_ID)
    this._brain.decisionContext = null
  }

  // ---------------------------------------------------------------------------

  /** @private */
  _tick () {
    try {
      const ctx = buildDecisionContext(this._bot, this._brain, this._config)
      const scores = this._computeScores(ctx)

      // Attach scorer weights — create a new frozen object extending the context
      const enriched = Object.freeze(Object.assign(Object.create(null), ctx, scores))

      // Cache on brain — all systems read from here
      this._brain.decisionContext = enriched

      // Notify listeners only when something meaningful changed (suppress idle spam)
      const snap = `${enriched.coreState}|${enriched.hp}|${enriched.food}|${enriched.immediateDanger}|${enriched.recentAggroPressure}|${enriched.threatScore}|${enriched.survivalScore}|${enriched.currentTask}|${enriched.combatSessionActive}`
      if (snap !== this._prevSnapshot) {
        this._prevSnapshot = snap
        this._brain.eventBus.emit(TacticalEvents.CONTEXT_UPDATED, enriched)
      }
      
      // Output scores for NULLBIT Launcher (throttled: once per 2 seconds)
      const now = Date.now()
      if (now - this._lastScoreOutput > 2000) {
        this._lastScoreOutput = now
        console.log(JSON.stringify({
          type: 'scores',
          threatScore: scores.threatScore,
          survivalScore: scores.survivalScore,
          resourceScore: scores.resourceScore
        }))
      }
      
      // Output inventory telemetry (throttled: once per 5 seconds)
      if (now - this._lastInvOutput > 5000) {
        this._lastInvOutput = now
        const inv = this._bot.inventory
        const usedSlots = inv?.slots?.filter(i => i).length || 0
        const totalSlots = 36
        const freeSlots = totalSlots - usedSlots
        console.log(JSON.stringify({
          type: 'inv',
          fillRatio: ctx.inventoryFillRatio,
          freeSlots,
          usedSlots,
          totalSlots
        }))
      }

      // Output bot status telemetry (throttled: once per 2 seconds)
      if (now - this._lastStatusOutput > 2000) {
        this._lastStatusOutput = now
        const hp    = Math.round((ctx.hp ?? 0) * 10) / 10
        const maxHp = Math.round((ctx.maxHp ?? 20) * 10) / 10
        const food  = Math.round((this._bot?.food ?? 0) * 10) / 10
        const coreState = ctx.coreState || 'IDLE'
        console.log(JSON.stringify({
          type: 'status',
          hp,
          maxHp,
          food,
          state: coreState
        }))
      }

      // Output combat telemetry (throttled: once per 2 seconds)
      if (now - this._lastCombatOutput > 2000) {
        this._lastCombatOutput = now
        const coreState = ctx.coreState || 'IDLE'
        const isCombat = ctx.combatSessionActive || coreState === 'COMBAT' || coreState === 'FLEE'
        const targetDist = ctx.nearestThreatDistance != null
          ? Math.round(ctx.nearestThreatDistance * 10) / 10
          : null
        const heldItem = this._bot?.heldItem
        const weapon = heldItem ? heldItem.name : 'fist'
        const hp = ctx.hp ?? 0
        console.log(JSON.stringify({
          type: 'combat',
          mode: isCombat ? coreState : 'IDLE',
          targetDist: targetDist,
          weapon: weapon,
          lastAction: isCombat ? coreState : '—',
          status: isCombat ? 'ACTIVE' : (hp < 5 ? 'CRITICAL' : 'STANDBY')
        }))
      }

      // Output watchdog telemetry (throttled: once per 3 seconds)
      if (now - this._lastWatchdogOutput > 3000) {
        this._lastWatchdogOutput = now
        const coreState = ctx.coreState || 'IDLE'
        const taskKind = (typeof ctx.currentTask === 'string' ? ctx.currentTask : ctx.currentTask?.kind || ctx.currentTask?.type || 'NONE')
        const isExempt = this._brain?.watchdogExempt || false
        console.log(JSON.stringify({
          type: 'watchdog',
          lastCheck: new Date().toLocaleTimeString(),
          lockHolder: isExempt ? taskKind : (taskKind || 'NONE'),
          pathStatus: 'ok',
          status: isExempt ? 'EXEMPT' : (coreState === 'IDLE' ? 'STANDBY' : 'ACTIVE')
        }))
      }
    } catch (err) {
      try {
        this._brain.log.error('[TacticalDecisionEngine] tick error:', err?.message)
      } catch (_) {}
    }
  }

  /**
   * Compute normalised scorer weights from an immutable DecisionContext.
   *
   * @private
   * @param {import('./decisionContext').DecisionContext} ctx
   * @returns {{ threatScore: number, survivalScore: number, resourceScore: number }}
   */
  _computeScores (ctx) {
    // ── threatScore (0..1) ────────────────────────────────────────────────
    // Combines immediacy of danger + raw retreat pressure
    let threatScore = 0
    if (ctx.immediateDanger) {
      threatScore = 1.0
    } else if (ctx.recentAggroPressure) {
      threatScore = 0.7
    } else {
      // Scale combinedPressure (typical range 0..3) to 0..0.6
      threatScore = Math.min(0.6, ctx.threatPressure / 3)
    }

    // ── survivalScore (0..1) ─────────────────────────────────────────────
    // How urgently the bot needs to self-preserve (heal / eat)
    const hpRatio = ctx.maxHealth > 0 ? ctx.hp / ctx.maxHealth : 1
    const foodRatio = ctx.food / 20
    // Low HP is more critical than low food
    const hpScore = Math.max(0, 1 - hpRatio)         // 0=full HP, 1=dead
    const foodScore = Math.max(0, 1 - foodRatio) * 0.4 // 0=full food, 0.4=starving
    const survivalScore = Math.min(1, hpScore + foodScore)

    // ── resourceScore (0..1) ─────────────────────────────────────────────
    // How worthwhile it is to keep the current gather task running
    let resourceScore = 0
    if (ctx.currentTask) {
      // Base value: gather is always somewhat worthwhile
      resourceScore = 0.5
      // Boost if inventory isn't full (room to collect)
      if (ctx.inventoryFillRatio < 0.8) resourceScore += 0.3
      // Boost if carrying high-value items
      if (ctx.inventoryValueScore > 0.5) resourceScore += 0.2
      resourceScore = Math.min(1, resourceScore)
    }

    return {
      threatScore: parseFloat(threatScore.toFixed(3)),
      survivalScore: parseFloat(survivalScore.toFixed(3)),
      resourceScore: parseFloat(resourceScore.toFixed(3))
    }
  }
}

module.exports = { TacticalDecisionEngine }
