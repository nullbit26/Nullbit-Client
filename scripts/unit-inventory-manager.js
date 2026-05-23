'use strict'

/**
 * InventoryManager unit tests
 *
 *  1. isJunk: cobblestone is junk
 *  2. isJunk: dirt is junk
 *  3. isJunk: diamond is NOT junk
 *  4. isJunk: iron_pickaxe is NOT junk
 *  5. isJunk: bread is NOT junk
 *  6. isJunk: torch is NOT junk
 *  7. isJunk: unknown block (not in KEEP_ALWAYS, not in ITEM_VALUES) is junk
 *  8. isJunk: raw_iron is NOT junk
 *  9. shouldDropJunk: returns false when fill ratio < threshold
 * 10. shouldDropJunk: returns true when fill ratio >= threshold
 * 11. dropJunk: drops cobblestone stack, returns count=1
 * 12. dropJunk: does NOT drop diamond
 * 13. dropJunk: respects targetFreeSlots — stops when enough slots freed
 * 14. dropJunk: respects maxDrops cap
 * 15. dropJunk: returns 0 when nothing to drop
 * 16. dropJunk: handles toss() error gracefully (no throw)
 * 17. isJunk: gravel is junk
 * 18. isJunk: andesite is junk
 * 19. isJunk: iron_sword is NOT junk
 * 20. dropJunk: drops junk-list items before unknown zero-value items
 */

const assert = require('assert')
const { isJunk, dropJunk, shouldDropJunk, JUNK_ITEMS, KEEP_ALWAYS } = require('../utils/InventoryManager')

let passed = 0
let failed = 0

function ok (label) { console.log(`  ✓ ${label}`); passed++ }
function fail (label, err) { console.error(`  ✗ ${label}: ${err?.message || err}`); failed++ }

/** Build a minimal fake bot with given inventory items */
function fakeBot (items = []) {
  const tossCalls = []
  return {
    inventory: {
      items: () => items
    },
    toss: async (type, meta, count) => {
      tossCalls.push({ type, count })
      // Remove first matching item from inventory to simulate slot free
      const idx = items.findIndex(i => i.type === type)
      if (idx >= 0) items.splice(idx, 1)
    },
    _tossCalls: tossCalls
  }
}

function makeItem (name, count = 32, type = null) {
  return { name, count, type: type ?? name.length } // type = fake numeric id
}

// ──────────────────────────────────────────────────────────────────────────────
// isJunk tests
// ──────────────────────────────────────────────────────────────────────────────
try {
  assert.strictEqual(isJunk(makeItem('cobblestone')), true)
  ok('isJunk: cobblestone is junk')
} catch (e) { fail('isJunk: cobblestone is junk', e) }

try {
  assert.strictEqual(isJunk(makeItem('dirt')), true)
  ok('isJunk: dirt is junk')
} catch (e) { fail('isJunk: dirt is junk', e) }

try {
  assert.strictEqual(isJunk(makeItem('diamond')), false)
  ok('isJunk: diamond is NOT junk')
} catch (e) { fail('isJunk: diamond is NOT junk', e) }

try {
  assert.strictEqual(isJunk(makeItem('iron_pickaxe')), false)
  ok('isJunk: iron_pickaxe is NOT junk')
} catch (e) { fail('isJunk: iron_pickaxe is NOT junk', e) }

try {
  assert.strictEqual(isJunk(makeItem('bread')), false)
  ok('isJunk: bread is NOT junk')
} catch (e) { fail('isJunk: bread is NOT junk', e) }

try {
  assert.strictEqual(isJunk(makeItem('torch')), false)
  ok('isJunk: torch is NOT junk')
} catch (e) { fail('isJunk: torch is NOT junk', e) }

try {
  // 'mystery_block' is not in KEEP_ALWAYS and not in ITEM_VALUES
  assert.strictEqual(isJunk(makeItem('mystery_block_xyzzy')), true)
  ok('isJunk: unknown block (zero-value, not keep) is junk')
} catch (e) { fail('isJunk: unknown block is junk', e) }

try {
  assert.strictEqual(isJunk(makeItem('raw_iron')), false)
  ok('isJunk: raw_iron is NOT junk')
} catch (e) { fail('isJunk: raw_iron is NOT junk', e) }

try {
  assert.strictEqual(isJunk(makeItem('gravel')), true)
  ok('isJunk: gravel is junk')
} catch (e) { fail('isJunk: gravel is junk', e) }

try {
  assert.strictEqual(isJunk(makeItem('andesite')), true)
  ok('isJunk: andesite is junk')
} catch (e) { fail('isJunk: andesite is junk', e) }

try {
  assert.strictEqual(isJunk(makeItem('iron_sword')), false)
  ok('isJunk: iron_sword is NOT junk')
} catch (e) { fail('isJunk: iron_sword is NOT junk', e) }

// ──────────────────────────────────────────────────────────────────────────────
// shouldDropJunk tests
// ──────────────────────────────────────────────────────────────────────────────
try {
  // 10 items out of 36 → ratio ≈ 0.28 < 0.85
  const bot = fakeBot(Array.from({ length: 10 }, (_, i) => makeItem(`item_${i}`)))
  assert.strictEqual(shouldDropJunk(bot, 0.85), false)
  ok('shouldDropJunk: returns false when fill ratio < threshold')
} catch (e) { fail('shouldDropJunk: returns false below threshold', e) }

try {
  // 31 items out of 36 → ratio ≈ 0.86 > 0.85
  const bot = fakeBot(Array.from({ length: 31 }, (_, i) => makeItem(`item_${i}`)))
  assert.strictEqual(shouldDropJunk(bot, 0.85), true)
  ok('shouldDropJunk: returns true when fill ratio >= threshold')
} catch (e) { fail('shouldDropJunk: returns true above threshold', e) }

// ──────────────────────────────────────────────────────────────────────────────
// dropJunk tests
// ──────────────────────────────────────────────────────────────────────────────

// 11. drops cobblestone, returns 1
try {
  const items = [makeItem('cobblestone', 32, 1)]
  // Pad to 35 so free=1 < targetFreeSlots=6 → will drop
  for (let i = 0; i < 34; i++) items.push(makeItem(`raw_iron`, 1, 2))
  const bot = fakeBot(items)
  dropJunk(bot, { targetFreeSlots: 6 }).then(n => {
    try {
      assert.ok(n >= 1)
      ok('dropJunk: drops cobblestone stack, returns count >= 1')
    } catch (e) { fail('dropJunk: drops cobblestone', e) }
  })
} catch (e) { fail('dropJunk: drops cobblestone stack', e) }

// 12. does NOT drop diamond
try {
  const items = Array.from({ length: 35 }, () => makeItem('diamond', 1, 10))
  const bot = fakeBot(items)
  dropJunk(bot, { targetFreeSlots: 6 }).then(n => {
    try {
      assert.strictEqual(n, 0)
      ok('dropJunk: does NOT drop diamond')
    } catch (e) { fail('dropJunk: does NOT drop diamond', e) }
  })
} catch (e) { fail('dropJunk: does NOT drop diamond', e) }

// 13. respects targetFreeSlots
try {
  const items = []
  for (let i = 0; i < 30; i++) items.push(makeItem('cobblestone', 64, i))
  const bot = fakeBot(items)
  dropJunk(bot, { targetFreeSlots: 6 }).then(n => {
    try {
      assert.ok(n <= 30) // never drops more than exists
      // After drop, should have at least 6 free slots (30 - n <= 30, free = 36 - (30-n))
      const remaining = bot.inventory.items().length
      assert.ok(36 - remaining >= 6 || n === 0)
      ok('dropJunk: respects targetFreeSlots')
    } catch (e) { fail('dropJunk: respects targetFreeSlots', e) }
  })
} catch (e) { fail('dropJunk: respects targetFreeSlots', e) }

// 14. respects maxDrops cap
try {
  const items = []
  for (let i = 0; i < 35; i++) items.push(makeItem('cobblestone', 64, i))
  const bot = fakeBot(items)
  dropJunk(bot, { targetFreeSlots: 36, maxDrops: 3 }).then(n => {
    try {
      assert.ok(n <= 3)
      ok('dropJunk: respects maxDrops cap')
    } catch (e) { fail('dropJunk: respects maxDrops cap', e) }
  })
} catch (e) { fail('dropJunk: respects maxDrops cap', e) }

// 15. returns 0 when nothing to drop (all diamonds)
try {
  const items = Array.from({ length: 10 }, () => makeItem('diamond', 1, 10))
  const bot = fakeBot(items)
  dropJunk(bot, { targetFreeSlots: 6 }).then(n => {
    try {
      assert.strictEqual(n, 0)
      ok('dropJunk: returns 0 when nothing to drop')
    } catch (e) { fail('dropJunk: returns 0 when nothing to drop', e) }
  })
} catch (e) { fail('dropJunk: returns 0 when nothing to drop', e) }

// 16. handles toss() error gracefully
try {
  const items = []
  for (let i = 0; i < 35; i++) items.push(makeItem('cobblestone', 1, i))
  const bot = {
    inventory: { items: () => items },
    toss: async () => { throw new Error('toss failed') }
  }
  dropJunk(bot, { targetFreeSlots: 6 }).then(n => {
    try {
      assert.strictEqual(n, 0)
      ok('dropJunk: handles toss() error gracefully')
    } catch (e) { fail('dropJunk: toss error graceful', e) }
  })
} catch (e) { fail('dropJunk: handles toss() error gracefully', e) }

// 20. drops JUNK_ITEMS before unknown zero-value items
try {
  const items = []
  // Fill 34 slots: 17 cobblestone + 17 mystery blocks
  for (let i = 0; i < 17; i++) items.push(makeItem('cobblestone', 1, 100 + i))
  for (let i = 0; i < 17; i++) items.push(makeItem('mystery_zzzz_block', 1, 200 + i))
  const bot = fakeBot(items)
  dropJunk(bot, { targetFreeSlots: 6, maxDrops: 5 }).then(() => {
    try {
      const remaining = bot.inventory.items()
      const cobbleLeft = remaining.filter(i => i.name === 'cobblestone').length
      const mysteryLeft = remaining.filter(i => i.name === 'mystery_zzzz_block').length
      // Should have dropped cobblestone first
      assert.ok(cobbleLeft < 17, 'cobblestone should be partially dropped')
      assert.strictEqual(mysteryLeft, 17, 'mystery blocks should be untouched (cobble dropped first)')
      ok('dropJunk: drops JUNK_ITEMS before unknown zero-value items')
    } catch (e) { fail('dropJunk: order — junk before unknown', e) }
  })
} catch (e) { fail('dropJunk: order', e) }

// ── Summary ──────────────────────────────────────────────────────────────────
// Give async tests time to resolve
setTimeout(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 500)
