'use strict'

const assert = require('assert')

// ── Patch isCombatSessionActive before any requires ──
let combatSessionActive = false
const attackEntityPath = require.resolve('../attackEntity')
require.cache[attackEntityPath] = {
  id: attackEntityPath,
  filename: attackEntityPath,
  loaded: true,
  exports: {
    isCombatSessionActive: () => combatSessionActive,
    attackEntity: async () => {},
    stopAttack: () => {}
  }
}

// ── Stubs ──

function mkBus () {
  const listeners = {}
  const emitted = []
  return {
    on (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    off (ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn) },
    emit (ev, payload) {
      emitted.push({ ev, payload })
      for (const fn of (listeners[ev] || [])) fn(payload)
    },
    _emitted: emitted,
    _listeners: listeners
  }
}

function mkScheduler () {
  const tasks = {}
  return {
    registerPeriodic (_interval, cb, opts) { tasks[opts.id] = cb; return opts.id },
    unregister (id) { delete tasks[id] },
    _tasks: tasks,
    fireTick (id) { if (tasks[id]) tasks[id]({ tickIndex: 0 }) }
  }
}

function mkBot (overrides = {}) {
  const listeners = {}
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    food: overrides.food ?? 20,
    health: overrides.health ?? 20,
    maxHealth: 20,
    inventory: { items: () => overrides.items || [] },
    registry: { foodsByName: { bread: { foodPoints: 5 } } },
    on (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    removeListener (ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn) },
    ...overrides
  }
}

function mkBrain (overrides = {}) {
  const bus = mkBus()
  const scheduler = mkScheduler()
  return {
    eventBus: bus,
    scheduler,
    memory: {
      getCurrentThreats: () => overrides.threats || [],
      getActiveThreatMemory: () => overrides.threatMemory || []
    },
    state: { getState: () => overrides.coreState || 'IDLE' },
    log: { info () {}, warn () {}, debug () {}, error () {} },
    taskState: null,
    survivalSystem: null,
    recoveryHoldSystem: null,
    ...overrides
  }
}

// ── Require after stubs ──
const { buildDecisionContext } = require('../core/decisionContext')
const {
  getInventoryFillRatio,
  getInventoryValueScore,
  getFreeSlots,
  hasAnyFood,
  hasHealing,
  INVENTORY_SLOTS
} = require('../utils/inventoryValue')
const { TaskState } = require('../core/taskState')
const { RecoveryHoldSystem } = require('../systems/RecoveryHoldSystem')

let passed = 0
const total = 24

function ok (label) {
  passed++
  console.log(`  \u2713 ${label}`)
  if (passed === total) console.log(`\nunit-phase1: ${passed}/${total} OK`)
}

// ════════════════════════════════════════════════
// 1. inventoryValue
// ════════════════════════════════════════════════

function testInventoryValue () {
  const items18 = Array.from({ length: 18 }, (_, i) => ({ name: 'dirt', count: 1 }))
  const bot18 = mkBot({ items: items18 })
  assert.strictEqual(getInventoryFillRatio(bot18), 18 / INVENTORY_SLOTS)
  ok('inventoryFillRatio: 18/36 = 0.5')

  assert.strictEqual(getInventoryFillRatio(mkBot()), 0)
  ok('inventoryFillRatio: empty = 0')

  const botDiamonds = mkBot({ items: [{ name: 'diamond', count: 3 }] })
  assert.ok(getInventoryValueScore(botDiamonds) > 0, 'diamonds give value')
  ok('inventoryValueScore: diamonds > 0')

  assert.strictEqual(getInventoryValueScore(mkBot()), 0)
  ok('inventoryValueScore: empty = 0')

  assert.strictEqual(getFreeSlots(mkBot()), INVENTORY_SLOTS)
  ok('getFreeSlots: empty = 36')

  assert.strictEqual(getFreeSlots(bot18), INVENTORY_SLOTS - 18)
  ok('getFreeSlots: 18 used = 18 free')

  const botBread = mkBot({ items: [{ name: 'bread', count: 1 }] })
  assert.strictEqual(hasAnyFood(botBread), true)
  ok('hasAnyFood: bread = true')

  const botRotten = mkBot({ items: [{ name: 'rotten_flesh', count: 1 }] })
  assert.strictEqual(hasAnyFood(botRotten), false)
  ok('hasAnyFood: rotten_flesh = false')

  const botGoldenApple = mkBot({ items: [{ name: 'golden_apple', count: 1 }] })
  assert.strictEqual(hasHealing(botGoldenApple), true)
  ok('hasHealing: golden_apple = true')

  assert.strictEqual(hasHealing(mkBot()), false)
  ok('hasHealing: empty = false')
}

// ════════════════════════════════════════════════
// 2. TaskState
// ════════════════════════════════════════════════

function testTaskState () {
  const ts = new TaskState()
  assert.strictEqual(ts.currentTask, null)
  assert.strictEqual(ts.interruptedTask, null)
  ok('taskState: initial state is null')

  ts.setCurrentTask({ kind: 'gather', resource: 'wood' })
  assert.strictEqual(ts.currentTask?.kind, 'gather')
  assert.ok(ts.currentTask?.setAt > 0)
  ok('taskState: setCurrentTask stores task + setAt')

  ts.interruptCurrentTask('HOSTILE_CONTACT')
  assert.strictEqual(ts.currentTask, null)
  assert.strictEqual(ts.interruptedTask?.kind, 'gather')
  assert.strictEqual(ts.interruptedTask?.interruptionReason, 'HOSTILE_CONTACT')
  assert.ok(ts.interruptedTask?.interruptedAt > 0)
  ok('taskState: interruptCurrentTask moves to interruptedTask')

  const restored = ts.restoreInterruptedTask()
  assert.strictEqual(restored?.kind, 'gather')
  assert.strictEqual(ts.currentTask?.kind, 'gather')
  assert.strictEqual(ts.interruptedTask, null)
  ok('taskState: restoreInterruptedTask brings task back')

  ts.clearCurrentTask()
  assert.strictEqual(ts.currentTask, null)
  ok('taskState: clearCurrentTask = null')

  ts.setCurrentTask({ kind: 'deliver' })
  ts.interruptCurrentTask('FLEE')
  ts.clear()
  assert.strictEqual(ts.currentTask, null)
  assert.strictEqual(ts.interruptedTask, null)
  ok('taskState: clear() resets all')
}

// ════════════════════════════════════════════════
// 3. DecisionContext
// ════════════════════════════════════════════════

function testDecisionContext () {
  combatSessionActive = false
  const brain = mkBrain({ coreState: 'IDLE' })
  const bot = mkBot({ health: 15, food: 12, items: [{ name: 'bread', count: 1 }] })
  const ctx = buildDecisionContext(bot, brain, {})

  assert.ok(typeof ctx.now === 'number')
  assert.strictEqual(ctx.coreState, 'IDLE')
  assert.strictEqual(ctx.combatSessionActive, false)
  assert.strictEqual(ctx.hp, 15)
  assert.strictEqual(ctx.food, 12)
  assert.strictEqual(ctx.hasFood, true)
  assert.strictEqual(ctx.inventoryFillRatio, 1 / INVENTORY_SLOTS)
  assert.ok(Object.isFrozen(ctx))
  ok('decisionContext: shape correct + frozen')

  combatSessionActive = true
  const ctx2 = buildDecisionContext(bot, brain, {})
  assert.strictEqual(ctx2.combatSessionActive, true)
  ok('decisionContext: reflects combatSessionActive')
  combatSessionActive = false

  const brainFlee = mkBrain({ coreState: 'FLEE', threats: [{ id: 1, name: 'zombie', distance: 3 }] })
  const ctx3 = buildDecisionContext(bot, brainFlee, {})
  assert.strictEqual(ctx3.coreState, 'FLEE')
  assert.strictEqual(ctx3.immediateDanger, true)
  assert.strictEqual(ctx3.nearestThreatDistance, 3)
  ok('decisionContext: threat fields populated from memory')
}

// ════════════════════════════════════════════════
// 4. RecoveryHoldSystem
// ════════════════════════════════════════════════

function testRecoveryHoldSystem () {
  combatSessionActive = false

  // 4a: enter / isActive / destroy
  {
    const brain = mkBrain()
    const bot = mkBot()
    const sys = new RecoveryHoldSystem({ bot, brain, config: { recoveryHoldMinMs: 0 } })
    sys.init()
    assert.strictEqual(sys.isActive(), false, 'starts inactive')
    sys.enter('MANUAL')
    assert.strictEqual(sys.isActive(), true)
    const entered = brain.eventBus._emitted.find((e) => e.ev === 'recovery_hold:enter')
    assert.ok(entered, 'ENTER event emitted')
    assert.strictEqual(entered.payload.reason, 'MANUAL')
    sys.destroy()
    assert.strictEqual(sys.isActive(), false)
    ok('recoveryHoldSystem: enter/isActive/destroy')
  }

  // 4b: releases when safe (minHoldMs=0, no threats)
  {
    const brain = mkBrain({ coreState: 'IDLE' })
    const bot = mkBot({ health: 20 })
    const sys = new RecoveryHoldSystem({ bot, brain, config: { recoveryHoldMinMs: 0 } })
    sys.init()
    sys.enter('POST_FLEE')
    brain.scheduler.fireTick('recovery_hold_system_tick')
    assert.strictEqual(sys.isActive(), false, 'released when safe')
    const exited = brain.eventBus._emitted.find((e) => e.ev === 'recovery_hold:exit')
    assert.ok(exited, 'EXIT event emitted')
    sys.destroy()
    ok('recoveryHoldSystem: releases when safe')
  }

  // 4c: does NOT release during active combat session
  {
    combatSessionActive = true
    const brain = mkBrain({ coreState: 'IDLE' })
    const bot = mkBot({ health: 20 })
    const sys = new RecoveryHoldSystem({ bot, brain, config: { recoveryHoldMinMs: 0 } })
    sys.init()
    sys.enter('POST_FLEE')
    brain.scheduler.fireTick('recovery_hold_system_tick')
    assert.strictEqual(sys.isActive(), true, 'stays active during combat session')
    sys.destroy()
    combatSessionActive = false
    ok('recoveryHoldSystem: holds during combat session')
  }

  // 4d: does NOT release during FLEE state
  {
    const brain = mkBrain({ coreState: 'FLEE' })
    const bot = mkBot({ health: 20 })
    const sys = new RecoveryHoldSystem({ bot, brain, config: { recoveryHoldMinMs: 0 } })
    sys.init()
    sys.enter('POST_FLEE')
    brain.scheduler.fireTick('recovery_hold_system_tick')
    assert.strictEqual(sys.isActive(), true, 'stays active during FLEE')
    sys.destroy()
    ok('recoveryHoldSystem: holds during FLEE state')
  }

  // 4e: auto-enters on STATE_CHANGED FLEE → IDLE
  {
    const brain = mkBrain()
    const bot = mkBot()
    const sys = new RecoveryHoldSystem({ bot, brain, config: { recoveryHoldMinMs: 99999 } })
    sys.init()
    brain.eventBus.emit('core:state_changed', { from: 'FLEE', to: 'IDLE', at: Date.now() })
    assert.strictEqual(sys.isActive(), true, 'auto-entered on FLEE → IDLE')
    sys.destroy()
    ok('recoveryHoldSystem: auto-enter on FLEE → IDLE')
  }

  // 4f: max timeout forces exit
  {
    const brain = mkBrain({ coreState: 'IDLE' })
    const bot = mkBot({ health: 4, items: [{ name: 'bread', count: 1 }] })
    const sys = new RecoveryHoldSystem({ bot, brain, config: { recoveryHoldMinMs: 0, recoveryHoldMaxMs: 1 } })
    sys.init()
    sys.enter('TEST')
    setTimeout(() => {
      brain.scheduler.fireTick('recovery_hold_system_tick')
      assert.strictEqual(sys.isActive(), false, 'max timeout forces exit')
      const exited = brain.eventBus._emitted.find((e) => e.ev === 'recovery_hold:exit')
      assert.ok(exited?.payload?.reason === 'MAX_HOLD_TIMEOUT')
      sys.destroy()
      ok('recoveryHoldSystem: max timeout forces exit')
    }, 5)
  }
}

function main () {
  testInventoryValue()
  testTaskState()
  testDecisionContext()
  testRecoveryHoldSystem()
}

main()
