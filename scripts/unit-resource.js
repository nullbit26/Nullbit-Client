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

function mkBus () {
  const listeners = {}
  const emitted = []
  return {
    on (ev, fn) { 
      console.log(`Bus: subscribing to ${ev}`)
      ;(listeners[ev] = listeners[ev] || []).push(fn) 
    },
    off (ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn) },
    emit (ev, payload) {
      console.log(`Bus: emitting ${ev} to ${listeners[ev]?.length || 0} listeners`)
      emitted.push({ ev, payload })
      for (const fn of (listeners[ev] || [])) {
        console.log(`Bus: calling listener for ${ev}`)
        fn(payload)
      }
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
    fireTick (id) { if (tasks[id]) tasks[id]() }
  }
}

function mkRecoveryHold () {
  const calls = []
  return {
    enter (reason) { calls.push(reason) },
    _calls: calls
  }
}

function mkTaskState () {
  return {
    currentTask: null,
    interruptedTask: null,
    setCurrentTask (task) { this.currentTask = task ? { ...task, setAt: Date.now() } : null },
    clearCurrentTask () { this.currentTask = null },
    interruptCurrentTask (reason) {
      if (!this.currentTask) return
      this.interruptedTask = { ...this.currentTask, interruptionReason: reason, interruptedAt: Date.now() }
      this.currentTask = null
    }
  }
}

function mkBot (overrides = {}) {
  const pos = overrides.position || { x: 0, y: 64, z: 0 }
  return {
    entity: { position: pos },
    health: 20,
    food: 20,
    inventory: { 
      items: () => (overrides.inventoryItems || []),
      slots: new Array(36).fill(null)
    },
    findBlock: overrides.findBlock || (() => null),
    blockAt: overrides.blockAt || (() => null),
    dig: overrides.dig || (async () => {}),
    ...overrides
  }
}

function mkBrain (overrides = {}) {
  const bus = overrides.bus || mkBus()
  const scheduler = mkScheduler()
  const taskState = overrides.taskState || mkTaskState()
  const recoveryHoldSystem = overrides.recoveryHoldSystem || mkRecoveryHold()
  let currentState = overrides.coreState || 'IDLE'
  return {
    eventBus: bus,
    scheduler,
    taskState,
    recoveryHoldSystem,
    state: { 
      getState: () => currentState,
      _setState: (s) => { currentState = s }
    },
    memory: { getCurrentThreats: () => [], getActiveThreatMemory: () => [] },
    log: { info () {}, warn () {}, debug () {}, error () {} },
    ...overrides
  }
}

const { ResourceSystem, GATHER_PHASE, LOG_NAME_RE } = require('../systems/ResourceSystem')

let passed = 0
let asyncPending = 0
const total = 17

function ok (label) {
  passed++
  console.log(`  \u2713 ${label}`)
  if (passed + asyncPending === total && asyncPending === 0) {
    console.log(`\nunit-resource: ${passed}/${total} OK`)
  }
}

function asyncOk (label) {
  asyncPending--
  ok(label)
  if (passed === total && asyncPending === 0) {
    console.log(`\nunit-resource: ${passed}/${total} OK`)
  }
}

// ════════════════════════════════════════════════
// 1. LOG_NAME_RE
// ════════════════════════════════════════════════

assert.ok(LOG_NAME_RE.test('oak_log'))
assert.ok(LOG_NAME_RE.test('birch_log'))
assert.ok(LOG_NAME_RE.test('crimson_stem'))
assert.ok(LOG_NAME_RE.test('warped_hyphae'))
assert.ok(!LOG_NAME_RE.test('oak_planks'))
assert.ok(!LOG_NAME_RE.test('dirt'))
ok('LOG_NAME_RE matches log/stem/hyphae/wood names')

// ════════════════════════════════════════════════
// 2. startGather / isGathering / stopGather
// ════════════════════════════════════════════════

{
  const brain = mkBrain()
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: { resourceNavPollMs: 0 } })
  sys.init()
  assert.strictEqual(sys.isGathering(), false)
  sys.startGather('wood')
  assert.strictEqual(sys.isGathering(), true)
  assert.strictEqual(brain.taskState.currentTask?.kind, 'gather')
  assert.strictEqual(brain.taskState.currentTask?.resource, 'wood')
  sys.stopGather('TEST')
  assert.strictEqual(sys.isGathering(), false)
  assert.strictEqual(brain.taskState.currentTask, null)
  sys.destroy()
  ok('startGather → isGathering=true + taskState set; stopGather → false + cleared')
}

// ════════════════════════════════════════════════
// 3. pauseGather → interruptedTask + recoveryHold
// ════════════════════════════════════════════════

{
  const recoveryHold = mkRecoveryHold()
  const taskState = mkTaskState()
  const brain = mkBrain({ recoveryHoldSystem: recoveryHold, taskState })
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: {} })
  sys.init()
  sys.startGather('wood')
  sys.pauseGather('HOSTILE_CONTACT')
  assert.strictEqual(sys.isGathering(), false)
  assert.strictEqual(taskState.interruptedTask?.kind, 'gather')
  assert.strictEqual(taskState.interruptedTask?.interruptionReason, 'HOSTILE_CONTACT')
  assert.strictEqual(recoveryHold._calls[0], 'GATHER_INTERRUPTED')
  const paused = brain.eventBus._emitted.find((e) => e.ev === 'resource:gather_paused')
  assert.ok(paused, 'GATHER_PAUSED event emitted')
  sys.destroy()
  ok('pauseGather: interruptedTask set + recoveryHold entered + event emitted')
}

// ════════════════════════════════════════════════
// 4. pauseGather is idempotent (no-op if not active)
// ════════════════════════════════════════════════

{
  const recoveryHold = mkRecoveryHold()
  const brain = mkBrain({ recoveryHoldSystem: recoveryHold })
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: {} })
  sys.init()
  sys.pauseGather('SHOULD_NOT_FIRE')
  assert.strictEqual(recoveryHold._calls.length, 0)
  sys.destroy()
  ok('pauseGather: no-op when not gathering')
}

// ════════════════════════════════════════════════
// 5. _shouldInterrupt — COMBAT state
// ════════════════════════════════════════════════

{
  const brain = mkBrain({ coreState: 'COMBAT' })
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: {} })
  assert.strictEqual(sys._shouldInterrupt(), true)
  ok('_shouldInterrupt: true in COMBAT state')
}

// ════════════════════════════════════════════════
// 6. _shouldInterrupt — FLEE state
// ════════════════════════════════════════════════

{
  const brain = mkBrain({ coreState: 'FLEE' })
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: {} })
  assert.strictEqual(sys._shouldInterrupt(), true)
  ok('_shouldInterrupt: true in FLEE state')
}

// ════════════════════════════════════════════════
// 7. _shouldInterrupt — IDLE, no combat session
// ════════════════════════════════════════════════

{
  combatSessionActive = false
  const brain = mkBrain({ coreState: 'IDLE' })
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: {} })
  assert.strictEqual(sys._shouldInterrupt(), false)
  ok('_shouldInterrupt: false in IDLE, no combat session')
}

// ════════════════════════════════════════════════
// 8. _shouldInterrupt — active combat session
// ════════════════════════════════════════════════

{
  combatSessionActive = true
  const brain = mkBrain({ coreState: 'IDLE' })
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: {} })
  assert.strictEqual(sys._shouldInterrupt(), true)
  combatSessionActive = false
  ok('_shouldInterrupt: true during active combat session')
}

// ════════════════════════════════════════════════
// 9. STATE_CHANGED to COMBAT → auto pauseGather
// ════════════════════════════════════════════════

{
  const recoveryHold = mkRecoveryHold()
  const brain = mkBrain({ recoveryHoldSystem: recoveryHold })
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: {} })
  sys.init()
  sys.startGather('wood')
  console.log('Before emit: isGathering =', sys.isGathering())
  brain.eventBus.emit('core:state_changed', { from: 'IDLE', to: 'COMBAT', at: Date.now() })
  console.log('After emit: isGathering =', sys.isGathering())
  console.log('Recovery calls:', recoveryHold._calls)
  assert.strictEqual(sys.isGathering(), false)
  assert.strictEqual(recoveryHold._calls[0], 'GATHER_INTERRUPTED')
  sys.destroy()
  ok('STATE_CHANGED to COMBAT → auto pauseGather')
}

// ════════════════════════════════════════════════
// 10. STATE_CHANGED to FLEE → auto pauseGather
// ════════════════════════════════════════════════

{
  const recoveryHold = mkRecoveryHold()
  const brain = mkBrain({ recoveryHoldSystem: recoveryHold })
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: {} })
  sys.init()
  sys.startGather('wood')
  brain.eventBus.emit('core:state_changed', { from: 'IDLE', to: 'FLEE', at: Date.now() })
  assert.strictEqual(sys.isGathering(), false)
  assert.strictEqual(recoveryHold._calls[0], 'GATHER_INTERRUPTED')
  sys.destroy()
  ok('STATE_CHANGED to FLEE → auto pauseGather')
}

// ════════════════════════════════════════════════
// 11. _tick safety net — combat session triggers pauseGather
// ════════════════════════════════════════════════

{
  const recoveryHold = mkRecoveryHold()
  const brain = mkBrain({ recoveryHoldSystem: recoveryHold })
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: {} })
  sys.init()
  sys.startGather('wood')
  combatSessionActive = true
  brain.scheduler.fireTick('resource_system_tick')
  assert.strictEqual(sys.isGathering(), false)
  assert.ok(recoveryHold._calls.length > 0)
  combatSessionActive = false
  sys.destroy()
  ok('_tick: combat session triggers pauseGather safety net')
}

// ════════════════════════════════════════════════
// 12. bus event GATHER_START / GATHER_STOP
// ════════════════════════════════════════════════

{
  const brain = mkBrain()
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: { resourceNavPollMs: 0 } })
  sys.init()
  brain.eventBus.emit('resource:gather_start', { resource: 'wood', at: Date.now() })
  assert.strictEqual(sys.isGathering(), true)
  brain.eventBus.emit('resource:gather_stop', { at: Date.now() })
  assert.strictEqual(sys.isGathering(), false)
  sys.destroy()
  ok('bus events GATHER_START / GATHER_STOP work')
}

// ════════════════════════════════════════════════
// 13. destroy clears active gather
// ════════════════════════════════════════════════

{
  const brain = mkBrain()
  const sys = new ResourceSystem({ bot: mkBot(), brain, config: { resourceNavPollMs: 0 } })
  sys.init()
  sys.startGather('wood')
  assert.strictEqual(sys.isGathering(), true)
  sys.destroy()
  assert.strictEqual(sys.isGathering(), false)
  assert.strictEqual(brain.taskState.currentTask, null)
  ok('destroy: clears active gather + taskState')
}

// ════════════════════════════════════════════════
// 14. async: stops immediately when no blocks found
// ════════════════════════════════════════════════

asyncPending++
{
  const brain = mkBrain()
  const bot = mkBot({ findBlock: () => null })
  const sys = new ResourceSystem({ bot, brain, config: { resourceNavPollMs: 0 } })
  sys.init()
  sys.startGather('wood')
  setTimeout(() => {
    assert.strictEqual(sys.isGathering(), false, 'stops when no blocks found')
    assert.strictEqual(brain.taskState.currentTask, null)
    sys.destroy()
    asyncOk('async: stops immediately when no blocks found')
  }, 30)
}

// ════════════════════════════════════════════════
// 15. async: pauses when interrupt detected before digging
// ════════════════════════════════════════════════

asyncPending++
{
  const recoveryHold = mkRecoveryHold()
  const brain = mkBrain({ recoveryHoldSystem: recoveryHold })

  const blockPos = { x: 0, y: 64, z: 0 }
  const mockBlock = { position: blockPos, name: 'oak_log' }

  let findCount = 0
  const bot = mkBot({
    position: { x: 100, y: 64, z: 100 },
    findBlock: () => { findCount++; return mockBlock },
    dig: async () => {}
  })
  bot.entity = { position: { x: 100, y: 64, z: 100 } }

  combatSessionActive = false
  const sys = new ResourceSystem({ bot, brain, config: { resourceNavPollMs: 5 } })
  sys.init()
  sys.startGather('wood')

  setTimeout(() => {
    combatSessionActive = true
  }, 15)

  setTimeout(() => {
    combatSessionActive = false
    assert.strictEqual(sys.isGathering(), false, 'paused by combat session during nav')
    assert.ok(recoveryHold._calls.includes('GATHER_INTERRUPTED'))
    sys.destroy()
    asyncOk('async: pauses when combat session detected during navigation')
  }, 60)
}

// ════════════════════════════════════════════════
// 16. async: full happy-path — nav + dig + collecting
// ════════════════════════════════════════════════

asyncPending++
{
  const brain = mkBrain()
  const blockPos = { x: 2, y: 64, z: 0 }
  const mockBlock = { position: blockPos, name: 'oak_log' }
  let digCalled = false
  let findCallCount = 0

  const bot = mkBot({
    findBlock: () => {
      findCallCount++
      return findCallCount <= 1 ? mockBlock : null
    },
    blockAt: () => mockBlock,
    dig: async () => { digCalled = true }
  })
  bot.entity = { position: { x: 2, y: 64, z: 0 } }

  const sys = new ResourceSystem({ bot, brain, config: { resourceNavPollMs: 0, resourceDropsWaitMs: 0, resourceDigSettleMs: 0 } })
  sys.init()
  sys.startGather('wood')

  setTimeout(() => {
    assert.ok(digCalled, 'dig was called')
    assert.ok(
      brain.taskState.currentTask?.progress?.blocksCollected > 0 ||
      !sys.isGathering(),
      'blocksCollected incremented or loop stopped naturally'
    )
    sys.destroy()
    asyncOk('async: happy-path nav→dig→collect')
  }, 80)
}

// ════════════════════════════════════════════════
// 17. async: stops when inventory is full
// ════════════════════════════════════════════════
asyncPending++
{
  const brain = mkBrain()
  // Simulate full inventory: 35 items in 36 slots (1 free = ≤2)
  const fakeItems = Array.from({ length: 35 }, (_, i) => ({ name: `item_${i}`, count: 1 }))
  const bot = mkBot({
    inventory: { items: () => fakeItems },
    findBlock: () => ({ position: { x: 1, y: 64, z: 0 }, name: 'oak_log' })
  })

  const sys = new ResourceSystem({ bot, brain, config: { resourceNavPollMs: 0 } })
  sys.init()
  sys.startGather('wood')

  setTimeout(() => {
    assert.strictEqual(sys.isGathering(), false, 'gather stopped on full inventory')
    assert.strictEqual(brain.taskState.currentTask, null, 'taskState cleared')
    sys.destroy()
    asyncOk('async: stops when inventory is full')
  }, 60)
}
