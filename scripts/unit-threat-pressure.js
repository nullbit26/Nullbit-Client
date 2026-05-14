'use strict'

const assert = require('assert')
const { evaluateThreatPressure, evaluateRetreatScore } = require('../combat/flee/evaluateThreatPressure')

function mkMemory ({ threats = [], threatMemory = [] }) {
  return {
    getCurrentThreats: () => threats.map((t) => ({ ...t })),
    getActiveThreatMemory: () => threatMemory.map((t) => ({ ...t }))
  }
}

function mkBot () {
  return { entity: { position: { x: 0, y: 64, z: 0 } } }
}

function main () {
  const now = Date.now()
  const baseConfig = {
    combatFleeHealSafeBlocks: 16,
    combatFleeRecoverThreatBlocks: 18,
    combatFleeClearThreatBlocks: 14
  }

  // 1) fresh aggro + temporary distance gain -> healing still blocked
  const freshAggro = evaluateThreatPressure(
    mkBot(),
    mkMemory({
      threats: [{ id: 1, name: 'zombie', distance: 19 }],
      threatMemory: [{ entityId: 1, lastSeenAt: now - 500, expiresAt: now + 110000 }]
    }),
    baseConfig,
    now
  )
  assert.strictEqual(freshAggro.healWindowSafe, false, 'fresh aggro should block immediate heal window')

  // 2) stale aggro + low current pressure -> recover/exit should be safe
  const staleAggro = evaluateThreatPressure(
    mkBot(),
    mkMemory({
      threats: [],
      threatMemory: [{ entityId: 2, lastSeenAt: now - 16000, expiresAt: now + 40000 }]
    }),
    baseConfig,
    now
  )
  assert.strictEqual(staleAggro.safeToRecover, true, 'stale aggro should allow recover')
  assert.strictEqual(staleAggro.safeToExitFlee, true, 'stale aggro should allow flee exit')

  // 3) multiple nearby threats > one weak stale threat
  const multiThreat = evaluateThreatPressure(
    mkBot(),
    mkMemory({
      threats: [
        { id: 10, name: 'zombie', distance: 8 },
        { id: 11, name: 'skeleton', distance: 10 },
        { id: 12, name: 'spider', distance: 11 }
      ],
      threatMemory: [{ entityId: 10, lastSeenAt: now - 1200, expiresAt: now + 100000 }]
    }),
    baseConfig,
    now
  )
  const weakThreat = evaluateThreatPressure(
    mkBot(),
    mkMemory({
      threats: [{ id: 20, name: 'zombie', distance: 19 }],
      threatMemory: [{ entityId: 20, lastSeenAt: now - 10000, expiresAt: now + 100000 }]
    }),
    baseConfig,
    now
  )
  assert.ok(multiThreat.combinedPressure > weakThreat.combinedPressure, 'multiple nearby threats should increase pressure')

  // 4) retreat score should react to pressure + hp deficit
  const pressured = evaluateThreatPressure(
    { ...mkBot(), health: 12, maxHealth: 20 },
    mkMemory({
      threats: [
        { id: 30, name: 'zombie', distance: 7 },
        { id: 31, name: 'skeleton', distance: 8 }
      ],
      threatMemory: [{ entityId: 30, lastSeenAt: now - 400, expiresAt: now + 100000 }]
    }),
    baseConfig,
    now
  )
  const calm = evaluateThreatPressure(
    { ...mkBot(), health: 12, maxHealth: 20 },
    mkMemory({
      threats: [{ id: 40, name: 'zombie', distance: 20 }],
      threatMemory: [{ entityId: 40, lastSeenAt: now - 11000, expiresAt: now + 100000 }]
    }),
    baseConfig,
    now
  )
  assert.ok(pressured.retreatScore > calm.retreatScore, 'retreat score should rise under higher pressure')
  assert.strictEqual(typeof evaluateRetreatScore, 'function', 'retreat score helper exported')

  console.log('unit-threat-pressure: OK')
}

main()
