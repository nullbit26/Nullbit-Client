'use strict'

/**
 * Phase 3 — TacticalDecisionEngine unit tests
 *
 * Tests:
 *   1. TacticalDecisionEngine: init registers scheduler task
 *   2. TacticalDecisionEngine: _tick populates brain.decisionContext
 *   3. TacticalDecisionEngine: context is frozen
 *   4. TacticalDecisionEngine: scorer fields present and in range
 *   5. TacticalDecisionEngine: threatScore = 1 when immediateDanger
 *   6. TacticalDecisionEngine: survivalScore near 1 when hp=0
 *   7. TacticalDecisionEngine: resourceScore > 0 when currentTask present
 *   8. TacticalDecisionEngine: resourceScore = 0 when no currentTask
 *   9. TacticalDecisionEngine: destroy clears brain.decisionContext
 *  10. TacticalDecisionEngine: tick error is caught, does not throw
 *  11. TacticalEvents registered in EventRegistry
 *  12. BotBrain: decisionContext initially null
 *  13. SurvivalSystem: skip tick when ctx.immediateDanger
 *  14. GatherGuardSystem: _getOrBuildPressure returns cached ctx when fresh
 *  15. GatherGuardSystem: _getOrBuildPressure calls live when stale
 */

const assert = require('assert')

const { TacticalDecisionEngine } = require('../core/TacticalDecisionEngine')
const { TacticalEvents, REGISTERED_EVENT_NAMES } = require('../core/EventRegistry')
const { buildDecisionContext } = require('../core/decisionContext')

let passed = 0
let failed = 0

function ok (label) {
  console.log(`  ✓ ${label}`)
  passed++
}

function fail (label, err) {
  console.error(`  ✗ ${label}: ${err?.message || err}`)
  failed++
}

// ── Helpers ─────────────────────────────────────────────────────────────────

let _combatSessionActive = false

jest_mock: {
  // Patch isCombatSessionActive for unit context
  const attackEntity = require('../attackEntity')
  Object.defineProperty(attackEntity, 'isCombatSessionActive', {
    get: () => () => _combatSessionActive,
    configurable: true
  })
}

function mkBot (overrides = {}) {
  return {
    health: overrides.health ?? 20,
    food: overrides.food ?? 20,
    maxHealth: overrides.maxHealth ?? 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {},
    inventory: { items: () => (overrides.items || []) },
    registry: null,
    ...overrides
  }
}

function mkMemory (overrides = {}) {
  return {
    getCurrentThreats: () => overrides.threats || [],
    getActiveThreatMemory: () => overrides.threatMemory || []
  }
}

function mkTaskState (currentTask = null) {
  return { currentTask, interruptedTask: null }
}

function mkBrain (overrides = {}) {
  const tasks = []
  const emitted = []
  const brain = {
    state: { getState: () => overrides.coreState || 'IDLE' },
    memory: mkMemory(overrides),
    taskState: mkTaskState(overrides.currentTask || null),
    survivalSystem: { isActive: () => false },
    recoveryHoldSystem: { isActive: () => false },
    decisionContext: null,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    scheduler: {
      registerPeriodic: (interval, cb, opts) => { tasks.push({ id: opts?.id, cb }) },
      unregister: (id) => {
        const i = tasks.findIndex(t => t.id === id)
        if (i !== -1) tasks.splice(i, 1)
      },
      _tasks: tasks
    },
    eventBus: {
      emit: (event, payload) => { emitted.push({ event, payload }) },
      _emitted: emitted
    },
    _tasks: tasks
  }
  return brain
}

// ── Tests ────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// 1. init registers scheduler task
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot()
  const brain = mkBrain()
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  assert.ok(brain._tasks.length === 1, 'one task registered')
  assert.strictEqual(brain._tasks[0].id, 'tactical_decision_engine_tick')
  ok('init: registers scheduler task with correct id')
} catch (e) { fail('init: registers scheduler task with correct id', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 2. _tick populates brain.decisionContext
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot()
  const brain = mkBrain()
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  brain._tasks[0].cb({ tickIndex: 0 })
  assert.ok(brain.decisionContext !== null, 'decisionContext set after tick')
  ok('_tick: populates brain.decisionContext')
} catch (e) { fail('_tick: populates brain.decisionContext', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 3. context is frozen
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot()
  const brain = mkBrain()
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  brain._tasks[0].cb({ tickIndex: 0 })
  assert.ok(Object.isFrozen(brain.decisionContext), 'context is frozen')
  ok('_tick: context is frozen')
} catch (e) { fail('_tick: context is frozen', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 4. scorer fields present and in range
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot()
  const brain = mkBrain()
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  brain._tasks[0].cb({ tickIndex: 0 })
  const ctx = brain.decisionContext
  assert.ok(typeof ctx.threatScore === 'number' && ctx.threatScore >= 0 && ctx.threatScore <= 1)
  assert.ok(typeof ctx.survivalScore === 'number' && ctx.survivalScore >= 0 && ctx.survivalScore <= 1)
  assert.ok(typeof ctx.resourceScore === 'number' && ctx.resourceScore >= 0 && ctx.resourceScore <= 1)
  ok('_tick: scorer fields present and in 0..1 range')
} catch (e) { fail('_tick: scorer fields present and in 0..1 range', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 5. threatScore = 1 when immediateDanger
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot({ health: 10 })
  // threat at distance 2 → immediateDanger = true
  const brain = mkBrain({ threats: [{ id: 1, name: 'zombie', distance: 2 }] })
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  brain._tasks[0].cb({ tickIndex: 0 })
  const ctx = brain.decisionContext
  assert.ok(ctx.immediateDanger === true, 'immediateDanger true')
  assert.strictEqual(ctx.threatScore, 1.0)
  ok('_tick: threatScore = 1.0 when immediateDanger')
} catch (e) { fail('_tick: threatScore = 1.0 when immediateDanger', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 6. survivalScore near 1 when hp=0
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot({ health: 0, food: 0, maxHealth: 20 })
  const brain = mkBrain()
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  brain._tasks[0].cb({ tickIndex: 0 })
  const ctx = brain.decisionContext
  assert.ok(ctx.survivalScore >= 0.9, `survivalScore should be ≥ 0.9, got ${ctx.survivalScore}`)
  ok('_tick: survivalScore near 1 when hp=0 food=0')
} catch (e) { fail('_tick: survivalScore near 1 when hp=0 food=0', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 7. resourceScore > 0 when currentTask present
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot()
  const brain = mkBrain({ currentTask: { kind: 'gather', resource: 'wood' } })
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  brain._tasks[0].cb({ tickIndex: 0 })
  assert.ok(brain.decisionContext.resourceScore > 0, 'resourceScore > 0 with task')
  ok('_tick: resourceScore > 0 when currentTask present')
} catch (e) { fail('_tick: resourceScore > 0 when currentTask present', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 8. resourceScore = 0 when no currentTask
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot()
  const brain = mkBrain({ currentTask: null })
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  brain._tasks[0].cb({ tickIndex: 0 })
  assert.strictEqual(brain.decisionContext.resourceScore, 0)
  ok('_tick: resourceScore = 0 when no currentTask')
} catch (e) { fail('_tick: resourceScore = 0 when no currentTask', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 9. destroy clears brain.decisionContext and unregisters task
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot()
  const brain = mkBrain()
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  brain._tasks[0].cb({ tickIndex: 0 })
  assert.ok(brain.decisionContext !== null)
  engine.destroy()
  assert.strictEqual(brain.decisionContext, null)
  assert.strictEqual(brain._tasks.length, 0)
  ok('destroy: clears decisionContext and unregisters task')
} catch (e) { fail('destroy: clears decisionContext and unregisters task', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 10. tick error is caught — does not throw
// ──────────────────────────────────────────────────────────────────────────────
try {
  const bot = mkBot()
  const brain = mkBrain()
  brain.memory = null // will cause buildDecisionContext to throw
  const engine = new TacticalDecisionEngine({ bot, brain, config: {} })
  engine.init()
  assert.doesNotThrow(() => brain._tasks[0].cb({ tickIndex: 0 }))
  ok('tick error is caught — does not throw')
} catch (e) { fail('tick error is caught — does not throw', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 11. TacticalEvents registered in EventRegistry
// ──────────────────────────────────────────────────────────────────────────────
try {
  assert.ok(TacticalEvents.CONTEXT_UPDATED === 'tactical:context_updated')
  assert.ok(REGISTERED_EVENT_NAMES.has('tactical:context_updated'))
  ok('TacticalEvents: CONTEXT_UPDATED registered in EventRegistry')
} catch (e) { fail('TacticalEvents: CONTEXT_UPDATED registered in EventRegistry', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 12. BotBrain: decisionContext initially null
// ──────────────────────────────────────────────────────────────────────────────
try {
  const brain = mkBrain()
  assert.strictEqual(brain.decisionContext, null)
  ok('BotBrain: decisionContext is null before first tick')
} catch (e) { fail('BotBrain: decisionContext is null before first tick', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 13. SurvivalSystem: skips tick when ctx.immediateDanger
// ──────────────────────────────────────────────────────────────────────────────
try {
  const { SurvivalSystem } = require('../systems/SurvivalSystem')
  let eatCalled = false
  const bot = mkBot({ food: 5 })
  bot.inventory = {
    items: () => [{ name: 'bread', count: 1 }]
  }
  bot.registry = { foodsByName: { bread: { effectiveQuality: 5 } } }
  bot.equip = async () => { eatCalled = true }
  bot.consume = async () => {}

  const brain = mkBrain()
  brain.scheduler = {
    registerPeriodic: () => {},
    unregister: () => {}
  }
  brain.eventBus = { on: () => {}, off: () => {}, emit: () => {} }
  brain.bot = bot

  const sys = new SurvivalSystem({ bot, brain, config: { survivalEatBelowFood: 18 } })
  // Set danger context — SurvivalSystem should skip
  brain.decisionContext = Object.freeze({
    now: Date.now(),
    immediateDanger: true,
    safeToRecover: false
  })
  sys._active = true
  sys._tick()
  assert.strictEqual(eatCalled, false, 'eat should not be called when immediateDanger')
  ok('SurvivalSystem: skips tick when ctx.immediateDanger')
} catch (e) { fail('SurvivalSystem: skips tick when ctx.immediateDanger', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 14. GatherGuardSystem: _getOrBuildPressure returns cached ctx when fresh
// ──────────────────────────────────────────────────────────────────────────────
try {
  const { GatherGuardSystem } = require('../systems/GatherGuardSystem')
  const bot = mkBot()
  const brain = mkBrain()
  brain.eventBus = { on: () => {}, off: () => {}, emit: () => {} }

  const mockRS = { isGathering: () => false, pauseGather: () => {}, startGather: () => {} }
  const sys = new GatherGuardSystem({ bot, brain, config: {}, resourceSystem: mockRS, state: {} })

  const freshCtx = Object.freeze({
    now: Date.now(), // very fresh
    nearbyThreatCount: 2,
    immediateDanger: false,
    combinedPressure: 0.3
  })
  brain.decisionContext = freshCtx

  const result = sys._getOrBuildPressure(mkMemory())
  assert.strictEqual(result, freshCtx, 'should return cached context')
  ok('GatherGuardSystem._getOrBuildPressure: returns fresh cached context')
} catch (e) { fail('GatherGuardSystem._getOrBuildPressure: returns fresh cached context', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 15. GatherGuardSystem: _getOrBuildPressure calls live when stale
// ──────────────────────────────────────────────────────────────────────────────
try {
  const { GatherGuardSystem } = require('../systems/GatherGuardSystem')
  const bot = mkBot()
  const brain = mkBrain()
  brain.eventBus = { on: () => {}, off: () => {}, emit: () => {} }

  const mockRS = { isGathering: () => false, pauseGather: () => {}, startGather: () => {} }
  const sys = new GatherGuardSystem({ bot, brain, config: {}, resourceSystem: mockRS, state: {} })

  // Stale context (200ms old)
  brain.decisionContext = Object.freeze({ now: Date.now() - 200 })

  const memory = mkMemory({ threats: [] })
  const result = sys._getOrBuildPressure(memory)
  assert.ok(result !== brain.decisionContext, 'should not return stale cached context')
  assert.ok(result !== null, 'should return live pressure')
  ok('GatherGuardSystem._getOrBuildPressure: calls live evaluateThreatPressure when stale')
} catch (e) { fail('GatherGuardSystem._getOrBuildPressure: calls live evaluateThreatPressure when stale', e) }

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
