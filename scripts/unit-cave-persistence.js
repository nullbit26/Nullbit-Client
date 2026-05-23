'use strict'

/**
 * Cave Persistence unit tests
 *
 * Tests:
 *   1. loadVisitedCaves: returns 0 when file does not exist
 *   2. saveVisitedCaves: writes valid JSON file
 *   3. loadVisitedCaves: correctly loads saved entries
 *   4. loadVisitedCaves: skips expired entries (TTL)
 *   5. loadVisitedCaves: skips malformed entries
 *   6. saveVisitedCaves: evicts expired entries before writing
 *   7. saveVisitedCaves: creates directory if missing
 *   8. Round-trip: save → load preserves all fresh entries
 *   9. addAndPersist: adds to map AND persists immediately
 *  10. loadVisitedCaves: returns count of loaded entries
 *  11. saveVisitedCaves: returns true on success
 *  12. saveVisitedCaves: returns false on write error
 *  13. loadVisitedCaves: returns 0 on parse error
 *  14. loadVisitedCaves: ignores entries without valid timestamp
 *  15. saveVisitedCaves: empty map writes empty entries array
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { loadVisitedCaves, saveVisitedCaves, addAndPersist } = require('../utils/CavePersistence')

let passed = 0
let failed = 0

function ok (label) { console.log(`  ✓ ${label}`); passed++ }
function fail (label, err) { console.error(`  ✗ ${label}: ${err?.message || err}`); failed++ }

/** Create a temp file path that doesn't exist yet */
function tmpPath () {
  return path.join(os.tmpdir(), `caves_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`)
}

const TTL = 25 * 60 * 1000 // 25 min

// ──────────────────────────────────────────────────────────────────────────────
// 1. load: returns 0 when file does not exist
// ──────────────────────────────────────────────────────────────────────────────
try {
  const map = new Map()
  const count = loadVisitedCaves(map, TTL, tmpPath())
  assert.strictEqual(count, 0)
  assert.strictEqual(map.size, 0)
  ok('load: returns 0 when file does not exist')
} catch (e) { fail('load: returns 0 when file does not exist', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 2. save: writes valid JSON file
// ──────────────────────────────────────────────────────────────────────────────
const f2 = tmpPath()
try {
  const map = new Map([['10,64,20', Date.now()]])
  saveVisitedCaves(map, TTL, f2)
  assert.ok(fs.existsSync(f2))
  const raw = JSON.parse(fs.readFileSync(f2, 'utf8'))
  assert.ok(Array.isArray(raw.entries))
  assert.strictEqual(raw.entries.length, 1)
  ok('save: writes valid JSON file')
} catch (e) { fail('save: writes valid JSON file', e) }
finally { try { fs.unlinkSync(f2) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 3. load: correctly loads saved entries
// ──────────────────────────────────────────────────────────────────────────────
const f3 = tmpPath()
try {
  const now = Date.now()
  const src = new Map([['1,2,3', now], ['4,5,6', now - 1000]])
  saveVisitedCaves(src, TTL, f3)
  const dst = new Map()
  const count = loadVisitedCaves(dst, TTL, f3)
  assert.strictEqual(count, 2)
  assert.ok(dst.has('1,2,3'))
  assert.ok(dst.has('4,5,6'))
  ok('load: correctly loads saved entries')
} catch (e) { fail('load: correctly loads saved entries', e) }
finally { try { fs.unlinkSync(f3) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 4. load: skips expired entries
// ──────────────────────────────────────────────────────────────────────────────
const f4 = tmpPath()
try {
  const expired = Date.now() - TTL - 1000 // older than TTL
  const fresh = Date.now()
  fs.writeFileSync(f4, JSON.stringify({ entries: [['0,0,0', expired], ['1,1,1', fresh]] }))
  const map = new Map()
  const count = loadVisitedCaves(map, TTL, f4)
  assert.strictEqual(count, 1)
  assert.ok(!map.has('0,0,0'), 'expired entry should be skipped')
  assert.ok(map.has('1,1,1'))
  ok('load: skips expired entries (TTL)')
} catch (e) { fail('load: skips expired entries (TTL)', e) }
finally { try { fs.unlinkSync(f4) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 5. load: skips malformed entries
// ──────────────────────────────────────────────────────────────────────────────
const f5 = tmpPath()
try {
  fs.writeFileSync(f5, JSON.stringify({
    entries: [
      [null, Date.now()],        // null key
      ['valid,key', 'notanum'],  // non-numeric ts
      ['good,key', Date.now()]   // valid
    ]
  }))
  const map = new Map()
  const count = loadVisitedCaves(map, TTL, f5)
  assert.strictEqual(count, 1)
  assert.ok(map.has('good,key'))
  ok('load: skips malformed entries')
} catch (e) { fail('load: skips malformed entries', e) }
finally { try { fs.unlinkSync(f5) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 6. save: evicts expired entries before writing
// ──────────────────────────────────────────────────────────────────────────────
const f6 = tmpPath()
try {
  const map = new Map([
    ['fresh', Date.now()],
    ['expired', Date.now() - TTL - 5000]
  ])
  saveVisitedCaves(map, TTL, f6)
  const raw = JSON.parse(fs.readFileSync(f6, 'utf8'))
  assert.strictEqual(raw.entries.length, 1)
  assert.strictEqual(raw.entries[0][0], 'fresh')
  ok('save: evicts expired entries before writing')
} catch (e) { fail('save: evicts expired entries before writing', e) }
finally { try { fs.unlinkSync(f6) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 7. save: creates directory if missing
// ──────────────────────────────────────────────────────────────────────────────
const f7dir = path.join(os.tmpdir(), `caves_dir_${Date.now()}`)
const f7 = path.join(f7dir, 'caves.json')
try {
  if (fs.existsSync(f7dir)) fs.rmdirSync(f7dir, { recursive: true })
  const map = new Map([['x,y,z', Date.now()]])
  const ok7 = saveVisitedCaves(map, TTL, f7)
  assert.ok(ok7)
  assert.ok(fs.existsSync(f7))
  ok('save: creates directory if missing')
} catch (e) { fail('save: creates directory if missing', e) }
finally { try { fs.rmSync(f7dir, { recursive: true, force: true }) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 8. Round-trip: save → load preserves all fresh entries
// ──────────────────────────────────────────────────────────────────────────────
const f8 = tmpPath()
try {
  const now = Date.now()
  const src = new Map([['10,64,20', now], ['30,32,50', now - 60_000], ['-5,40,100', now - 500_000]])
  saveVisitedCaves(src, TTL, f8)
  const dst = new Map()
  loadVisitedCaves(dst, TTL, f8)
  assert.ok(dst.has('10,64,20'))
  assert.ok(dst.has('30,32,50'))
  assert.ok(dst.has('-5,40,100'))
  assert.strictEqual(dst.size, 3)
  ok('round-trip: save → load preserves all fresh entries')
} catch (e) { fail('round-trip: save → load preserves all fresh entries', e) }
finally { try { fs.unlinkSync(f8) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 9. addAndPersist: adds to map AND persists immediately
// ──────────────────────────────────────────────────────────────────────────────
const f9 = tmpPath()
try {
  const map = new Map()
  const ts = Date.now()
  addAndPersist(map, '5,64,10', ts, TTL, f9)
  assert.ok(map.has('5,64,10'))
  assert.ok(fs.existsSync(f9))
  const raw = JSON.parse(fs.readFileSync(f9, 'utf8'))
  assert.strictEqual(raw.entries.length, 1)
  assert.strictEqual(raw.entries[0][0], '5,64,10')
  ok('addAndPersist: adds to map AND persists immediately')
} catch (e) { fail('addAndPersist: adds to map AND persists immediately', e) }
finally { try { fs.unlinkSync(f9) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 10. load: returns count of loaded entries
// ──────────────────────────────────────────────────────────────────────────────
const f10 = tmpPath()
try {
  const now = Date.now()
  fs.writeFileSync(f10, JSON.stringify({ entries: [['a', now], ['b', now], ['c', now]] }))
  const map = new Map()
  const count = loadVisitedCaves(map, TTL, f10)
  assert.strictEqual(count, 3)
  ok('load: returns correct count of loaded entries')
} catch (e) { fail('load: returns correct count of loaded entries', e) }
finally { try { fs.unlinkSync(f10) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 11. save: returns true on success
// ──────────────────────────────────────────────────────────────────────────────
const f11 = tmpPath()
try {
  const result = saveVisitedCaves(new Map([['k', Date.now()]]), TTL, f11)
  assert.strictEqual(result, true)
  ok('save: returns true on success')
} catch (e) { fail('save: returns true on success', e) }
finally { try { fs.unlinkSync(f11) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 12. save: returns false on write error (invalid path)
// ──────────────────────────────────────────────────────────────────────────────
try {
  // Pass a path that cannot be created (null byte in filename)
  const result = saveVisitedCaves(new Map([['k', Date.now()]]), TTL, '\0invalid')
  assert.strictEqual(result, false)
  ok('save: returns false on write error')
} catch (e) { fail('save: returns false on write error', e) }

// ──────────────────────────────────────────────────────────────────────────────
// 13. load: returns 0 on parse error (corrupted file)
// ──────────────────────────────────────────────────────────────────────────────
const f13 = tmpPath()
try {
  fs.writeFileSync(f13, 'NOT JSON {{{')
  const map = new Map()
  const count = loadVisitedCaves(map, TTL, f13)
  assert.strictEqual(count, 0)
  assert.strictEqual(map.size, 0)
  ok('load: returns 0 on parse error (corrupted file)')
} catch (e) { fail('load: returns 0 on parse error (corrupted file)', e) }
finally { try { fs.unlinkSync(f13) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 14. load: ignores entries without valid timestamp
// ──────────────────────────────────────────────────────────────────────────────
const f14 = tmpPath()
try {
  fs.writeFileSync(f14, JSON.stringify({ entries: [['key1', null], ['key2', undefined], ['key3', Date.now()]] }))
  const map = new Map()
  const count = loadVisitedCaves(map, TTL, f14)
  assert.strictEqual(count, 1)
  assert.ok(map.has('key3'))
  ok('load: ignores entries without valid timestamp')
} catch (e) { fail('load: ignores entries without valid timestamp', e) }
finally { try { fs.unlinkSync(f14) } catch (_) {} }

// ──────────────────────────────────────────────────────────────────────────────
// 15. save: empty map writes empty entries array
// ──────────────────────────────────────────────────────────────────────────────
const f15 = tmpPath()
try {
  saveVisitedCaves(new Map(), TTL, f15)
  const raw = JSON.parse(fs.readFileSync(f15, 'utf8'))
  assert.deepStrictEqual(raw.entries, [])
  ok('save: empty map writes empty entries array')
} catch (e) { fail('save: empty map writes empty entries array', e) }
finally { try { fs.unlinkSync(f15) } catch (_) {} }

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
