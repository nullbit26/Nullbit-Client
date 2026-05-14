'use strict'

const assert = require('assert')

// ── Minimal stubs ──

function mkBus () {
  const listeners = {}
  return {
    on (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    off (ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn) },
    emit (ev, payload) { for (const fn of (listeners[ev] || [])) fn(payload) },
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
    ...overrides
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
    registry: { foodsByName: { bread: { effectiveQuality: 5, foodPoints: 5 } } },
    equip: overrides.equip || (async () => {}),
    consume: overrides.consume || (async () => {}),
    on (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    removeListener (ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn) },
    _emitEvent (ev) { for (const fn of (listeners[ev] || [])) fn() },
    _listeners: listeners,
    ...overrides
  }
}

// Patch isCombatSessionActive before requiring SurvivalSystem
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

const { SurvivalSystem } = require('../systems/SurvivalSystem')

let passed = 0
let asyncPending = 0
const total = 12

function done () {
  if (passed + asyncPending >= total) return
  passed++
  if (passed === total) {
    console.log(`\nunit-survival: ${passed}/${total} OK`)
  }
}

function main () {
  // Test 1: on/off via bus events
  {
    const brain = mkBrain()
    const bot = mkBot()
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    assert.strictEqual(sys.isActive(), false, 'starts inactive')
    brain.eventBus.emit('survival:set', { at: Date.now() })
    assert.strictEqual(sys.isActive(), true, 'activated via bus')
    brain.eventBus.emit('survival:stop', { at: Date.now() })
    assert.strictEqual(sys.isActive(), false, 'deactivated via bus')
    sys.destroy()
    console.log('  \u2713 on/off')
    done()
  }

  // Test 2: yields to COMBAT state
  {
    const brain = mkBrain({ coreState: 'COMBAT' })
    const bot = mkBot({ food: 5, items: [{ name: 'bread', count: 1 }] })
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    brain.scheduler.fireTick('survival_system_tick')
    assert.strictEqual(sys._isEating, false, 'no eat during COMBAT')
    sys.destroy()
    console.log('  \u2713 yields to COMBAT')
    done()
  }

  // Test 3: yields to FLEE state
  {
    const brain = mkBrain({ coreState: 'FLEE' })
    const bot = mkBot({ food: 5, items: [{ name: 'bread', count: 1 }] })
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    brain.scheduler.fireTick('survival_system_tick')
    assert.strictEqual(sys._isEating, false, 'no eat during FLEE')
    sys.destroy()
    console.log('  \u2713 yields to FLEE')
    done()
  }

  // Test 4: yields to active combat session
  {
    combatSessionActive = true
    const brain = mkBrain({ coreState: 'IDLE' })
    const bot = mkBot({ food: 5, items: [{ name: 'bread', count: 1 }] })
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    brain.scheduler.fireTick('survival_system_tick')
    assert.strictEqual(sys._isEating, false, 'no eat during combat session')
    sys.destroy()
    combatSessionActive = false
    console.log('  \u2713 yields to combat session')
    done()
  }

  // Test 5: eats when hungry and safe
  {
    combatSessionActive = false
    let equipped = false
    let consumed = false
    const brain = mkBrain({ coreState: 'IDLE' })
    const bot = mkBot({
      food: 10,
      items: [{ name: 'bread', count: 1 }],
      equip: async () => { equipped = true },
      consume: async () => { consumed = true }
    })
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    brain.scheduler.fireTick('survival_system_tick')
    assert.strictEqual(sys._isEating, true, 'eating started')
    asyncPending++
    setTimeout(() => {
      asyncPending--
      assert.strictEqual(equipped, true, 'food equipped')
      assert.strictEqual(consumed, true, 'food consumed')
      assert.strictEqual(sys._isEating, false, 'eating finished')
      sys.destroy()
      console.log('  \u2713 eats when hungry and safe')
      done()
    }, 50)
  }

  // Test 6: does not eat when food is full
  {
    const brain = mkBrain({ coreState: 'IDLE' })
    const bot = mkBot({ food: 20, items: [{ name: 'bread', count: 1 }] })
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    brain.scheduler.fireTick('survival_system_tick')
    assert.strictEqual(sys._isEating, false, 'no eat when full')
    sys.destroy()
    console.log('  \u2713 no eat when full')
    done()
  }

  // Test 7: stop command deactivates survival
  {
    const brain = mkBrain()
    const bot = mkBot()
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    assert.strictEqual(sys.isActive(), true)
    brain.eventBus.emit('survival:stop', { at: Date.now() })
    assert.strictEqual(sys.isActive(), false, 'stop deactivates')
    sys.destroy()
    console.log('  \u2713 stop deactivates')
    done()
  }

  // Test 8: does not eat with threats nearby (immediateDanger)
  {
    const brain = mkBrain({
      coreState: 'IDLE',
      threats: [{ id: 1, name: 'zombie', distance: 3 }]
    })
    const bot = mkBot({ food: 5, items: [{ name: 'bread', count: 1 }] })
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    brain.scheduler.fireTick('survival_system_tick')
    assert.strictEqual(sys._isEating, false, 'no eat with threats nearby')
    sys.destroy()
    console.log('  \u2713 no eat with threats nearby')
    done()
  }

  // Test 9: stop during in-flight eat — deactivates, no new eat starts
  {
    combatSessionActive = false
    let consumeResolve
    const consumePromise = new Promise((r) => { consumeResolve = r })
    const brain = mkBrain({ coreState: 'IDLE' })
    const bot = mkBot({
      food: 10,
      items: [{ name: 'bread', count: 1 }],
      equip: async () => {},
      consume: () => consumePromise
    })
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    brain.scheduler.fireTick('survival_system_tick')
    assert.strictEqual(sys._isEating, true, 'eating in-flight')
    brain.eventBus.emit('survival:stop', { at: Date.now() })
    assert.strictEqual(sys.isActive(), false, 'deactivated immediately')
    assert.strictEqual(sys._isEating, false, '_isEating cleared by stop')
    consumeResolve()
    asyncPending++
    setTimeout(() => {
      asyncPending--
      brain.scheduler.fireTick('survival_system_tick')
      assert.strictEqual(sys._isEating, false, 'no new eat after stop')
      sys.destroy()
      console.log('  \u2713 stop during in-flight eat')
      done()
    }, 30)
  }

  // Test 10: eat failure triggers cooldown — next tick skipped
  {
    combatSessionActive = false
    let eatAttempts = 0
    const brain = mkBrain({ coreState: 'IDLE' })
    const bot = mkBot({
      food: 10,
      items: [{ name: 'bread', count: 1 }],
      equip: async () => { eatAttempts++ },
      consume: async () => { throw new Error('interrupted') }
    })
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    brain.scheduler.fireTick('survival_system_tick')
    asyncPending++
    setTimeout(() => {
      asyncPending--
      assert.strictEqual(eatAttempts, 1, 'first attempt fired')
      assert.strictEqual(sys._isEating, false, 'eating finished after fail')
      assert.ok(sys._eatCooldownUntil > Date.now(), 'cooldown set')
      brain.scheduler.fireTick('survival_system_tick')
      assert.strictEqual(eatAttempts, 1, 'second attempt blocked by cooldown')
      sys.destroy()
      console.log('  \u2713 eat failure cooldown')
      done()
    }, 30)
  }

  // Test 11: spawn resets _isEating (respawn while eating)
  {
    combatSessionActive = false
    let consumeResolve
    const consumePromise = new Promise((r) => { consumeResolve = r })
    const brain = mkBrain({ coreState: 'IDLE' })
    const bot = mkBot({
      food: 10,
      items: [{ name: 'bread', count: 1 }],
      equip: async () => {},
      consume: () => consumePromise
    })
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    brain.scheduler.fireTick('survival_system_tick')
    assert.strictEqual(sys._isEating, true, 'eating in-flight')
    bot._emitEvent('spawn')
    assert.strictEqual(sys._isEating, false, 'spawn resets _isEating')
    assert.strictEqual(sys.isActive(), true, '_active preserved after spawn')
    consumeResolve()
    sys.destroy()
    console.log('  \u2713 spawn resets _isEating')
    done()
  }

  // Test 12: destroy clears all flags even if active
  {
    const brain = mkBrain()
    const bot = mkBot()
    const sys = new SurvivalSystem({ bot, brain, config: {} })
    sys.init()
    brain.eventBus.emit('survival:set', { at: Date.now() })
    assert.strictEqual(sys.isActive(), true)
    sys._isEating = true
    sys._eatCooldownUntil = Date.now() + 99999
    sys.destroy()
    assert.strictEqual(sys.isActive(), false, 'destroy clears _active')
    assert.strictEqual(sys._isEating, false, 'destroy clears _isEating')
    assert.strictEqual(sys._eatCooldownUntil, 0, 'destroy clears cooldown')
    assert.strictEqual(sys._wired, false, 'destroy clears _wired')
    console.log('  \u2713 destroy clears all flags')
    done()
  }
}

main()
