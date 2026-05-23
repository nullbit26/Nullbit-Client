'use strict'

const assert = require('assert')

// ── Patch isCombatSessionActive before any requires ──
let combatSessionActive = false
const attackEntityPath = require.resolve('../attackEntity')
require.cache[attackEntityPath] = {
  id: attackEntityPath, filename: attackEntityPath, loaded: true,
  exports: { isCombatSessionActive: () => combatSessionActive, attackEntity: async () => {}, stopAttack: () => {} }
}

const { CoreStates } = require('../core/StateManager')
const { CoreEvents, ResourceEvents, RecovatoryHoldEventsKey } = (() => {
  const reg = require('../core/EventRegistry')
  return { CoreEvents: reg.CoreEvents, ResourceEvents: reg.ResourceEvents, RecoveryHoldEvents: reg.RecoveryHoldEvents }
})()
const { RecoveryHoldEvents } = require('../core/EventRegistry')
const { GatherGuardSystem } = require('../systems/GatherGuardSystem')

let passed = 0
let asyncPending = 0
const total = 6

function mkBus () {
  const listeners = {}
  const emitted = []
  return {
    on (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    off (ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn) },
    emit (ev, payload) {
      emitted.push({ ev, payload })
      for (const fn of (listeners[ev] || [])) fn(payload)
    },
    _emitted: emitted,
    _listeners: listeners
  }
}

function mkBrain (overrides = {}) {
  const bus = overrides.bus || mkBus()
  return {
    eventBus: bus,
    state: { getState: overrides.getState || (() => 'IDLE'), transition: () => {} },
    taskState: overrides.taskState || {
      currentTask: null,
      interruptedTask: null,
      setCurrentTask (t) { this.currentTask = t ? { ...t, setAt: Date.now() } : null },
      clearCurrentTask () { this.currentTask = null },
      clearInterruptedTask () { this.interruptedTask = null },
      interruptCurrentTask (reason) {
        if (!this.currentTask) return
        this.interruptedTask = { ...this.currentTask, interruptionReason: reason, interruptedAt: Date.now() }
        this.currentTask = null
      }
    },
    recoveryHoldSystem: overrides.recoveryHoldSystem || { isActive: () => false },
    memory: { getCurrentThreats: () => [], getActiveThreatMemory: () => [] },
    log: { info () {}, warn () {} },
    ...overrides,
    eventBus: bus
  }
}

function mkRS (overrides = {}) {
  let gathering = false
  const calls = []
  return {
    isGathering: () => gathering,
    startGather (type) { gathering = true; calls.push(type) },
    pauseGather (reason) { gathering = false },
    stopGather (reason) { gathering = false },
    _calls: calls,
    _setGathering (v) { gathering = v }
  }
}

function ok (label) {
  passed++
  console.log(`  ✓ ${label}`)
  check()
}

function asyncOk (label) {
  passed++
  asyncPending--
  console.log(`  ✓ ${label}`)
  check()
}

function check () {
  if (passed === total && asyncPending === 0) {
    console.log(`\nunit-gather-guard: ${passed}/${total} OK`)
  }
}

// ════════════════════════════════════════════════
// 1. _onStateChanged: ignores non-combat→idle transitions (e.g. FOLLOWING→IDLE)
// ════════════════════════════════════════════════
{
  const bus = mkBus()
  const rs = mkRS()
  const brain = mkBrain({ bus })
  brain.taskState.interruptedTask = { kind: 'gather', resource: 'wood' }
  const sys = new GatherGuardSystem({ bot: {}, brain, config: {}, resourceSystem: rs })
  sys.init()
  bus.emit(CoreEvents.STATE_CHANGED, { from: 'FOLLOWING', to: 'IDLE', at: Date.now() })
  // should NOT resume
  assert.strictEqual(rs._calls.length, 0, 'no resume on non-combat idle transition')
  sys.destroy()
  ok('_onStateChanged: ignores FOLLOWING→IDLE (non-combat transition)')
}

// ════════════════════════════════════════════════
// 2. _onStateChanged: ignores IDLE→IDLE transitions
// ════════════════════════════════════════════════
{
  const bus = mkBus()
  const rs = mkRS()
  const brain = mkBrain({ bus })
  brain.taskState.interruptedTask = { kind: 'gather', resource: 'wood' }
  const sys = new GatherGuardSystem({ bot: {}, brain, config: {}, resourceSystem: rs })
  sys.init()
  bus.emit(CoreEvents.STATE_CHANGED, { from: 'IDLE', to: 'IDLE', at: Date.now() })
  assert.strictEqual(rs._calls.length, 0, 'no resume on IDLE→IDLE')
  sys.destroy()
  ok('_onStateChanged: ignores IDLE→IDLE transition')
}

// ════════════════════════════════════════════════
// 3. _onStateChanged: resumes gather on COMBAT→IDLE with interruptedTask
// ════════════════════════════════════════════════
asyncPending++
{
  const bus = mkBus()
  const rs = mkRS()
  const brain = mkBrain({ bus })
  brain.taskState.interruptedTask = { kind: 'gather', resource: 'iron' }
  const sys = new GatherGuardSystem({ bot: {}, brain, config: {}, resourceSystem: rs })
  sys.init()
  bus.emit(CoreEvents.STATE_CHANGED, { from: CoreStates.COMBAT, to: CoreStates.IDLE, at: Date.now() })
  setTimeout(() => {
    assert.ok(rs._calls.includes('iron'), `startGather('iron') called, got: ${JSON.stringify(rs._calls)}`)
    sys.destroy()
    asyncOk('_onStateChanged: resumes gather on COMBAT→IDLE')
  }, 2200) // POST_COMBAT_COOLDOWN_MS(1500) + 200 + buffer
}

// ════════════════════════════════════════════════
// 4. _onStateChanged: resumes gather on FLEE→IDLE with interruptedTask
// ════════════════════════════════════════════════
asyncPending++
{
  const bus = mkBus()
  const rs = mkRS()
  const brain = mkBrain({ bus })
  brain.taskState.interruptedTask = { kind: 'gather', resource: 'wood' }
  const sys = new GatherGuardSystem({ bot: {}, brain, config: {}, resourceSystem: rs })
  sys.init()
  bus.emit(CoreEvents.STATE_CHANGED, { from: CoreStates.FLEE, to: CoreStates.IDLE, at: Date.now() })
  setTimeout(() => {
    assert.ok(rs._calls.includes('wood'), `startGather('wood') called, got: ${JSON.stringify(rs._calls)}`)
    sys.destroy()
    asyncOk('_onStateChanged: resumes gather on FLEE→IDLE')
  }, 2200)
}

// ════════════════════════════════════════════════
// 5. _onStateChanged: no resume when interruptedTask is null (manual stop clears it)
// ════════════════════════════════════════════════
asyncPending++
{
  const bus = mkBus()
  const rs = mkRS()
  const brain = mkBrain({ bus })
  brain.taskState.interruptedTask = null // manual stop cleared it
  const sys = new GatherGuardSystem({ bot: {}, brain, config: {}, resourceSystem: rs })
  sys.init()
  bus.emit(CoreEvents.STATE_CHANGED, { from: CoreStates.COMBAT, to: CoreStates.IDLE, at: Date.now() })
  setTimeout(() => {
    assert.strictEqual(rs._calls.length, 0, 'no resume when interruptedTask is null')
    sys.destroy()
    asyncOk('_onStateChanged: no resume when no interruptedTask (manual stop)')
  }, 2200)
}

// ════════════════════════════════════════════════
// 6. _resumeGather: defers to RecoveryHoldEvents.EXIT when hold is active
// ════════════════════════════════════════════════
asyncPending++
{
  const bus = mkBus()
  const rs = mkRS()
  let holdActive = true
  const brain = mkBrain({
    bus,
    recoveryHoldSystem: { isActive: () => holdActive }
  })
  brain.taskState.interruptedTask = { kind: 'gather', resource: 'coal' }
  const sys = new GatherGuardSystem({ bot: { health: 20, maxHealth: 20 }, brain, config: {}, resourceSystem: rs })
  sys.init()
  // Trigger a COMBAT→IDLE to fire _onStateChanged → _resumeGather (hold is active → deferred)
  bus.emit(CoreEvents.STATE_CHANGED, { from: CoreStates.COMBAT, to: CoreStates.IDLE, at: Date.now() })
  setTimeout(() => {
    // Hold still active → gather should NOT have started yet
    assert.strictEqual(rs._calls.length, 0, 'gather not started while hold active')
    // Now release hold
    holdActive = false
    bus.emit(RecoveryHoldEvents.EXIT, { reason: 'SAFE', at: Date.now(), heldMs: 4000 })
    setTimeout(() => {
      assert.ok(rs._calls.includes('coal'), `startGather('coal') called after hold exit, got: ${JSON.stringify(rs._calls)}`)
      sys.destroy()
      asyncOk('_resumeGather: defers until RecoveryHoldEvents.EXIT')
    }, 100)
  }, 2200)
}
