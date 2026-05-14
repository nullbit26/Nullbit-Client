'use strict'

const assert = require('assert')
const { waitUntilCombatInactive } = require('../combat/session/waitCombatInactive')

async function main () {
  let active = true
  /** @type {((evt: { active: boolean, at: number }) => void)[]} */
  const listeners = []

  const waiter = waitUntilCombatInactive({
    isActive: () => active,
    subscribeActiveChanged: (fn) => {
      listeners.push(fn)
      return () => {}
    },
    maxMs: 200,
    sleepMs: 20
  })

  setTimeout(() => {
    active = false
    for (const fn of listeners) fn({ active: false, at: Date.now() })
  }, 20)

  await waiter
  assert.strictEqual(active, false)
  console.log('unit-combat-lifecycle: OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
