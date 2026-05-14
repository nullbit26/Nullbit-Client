'use strict'

const assert = require('assert')
const { parsePlayerMessage } = require('../commands/parsePlayerMessage')
const { dispatchCommand } = require('../commands/dispatchCommand')
const { COMMAND_LOG_CODES } = require('../commands/commandLogCodes')

async function main () {
  const parsed = parsePlayerMessage('follow', { defendCapable: true })
  assert.ok(parsed && parsed.command === 'follow')

  const ctx = {
    log: () => {},
    safeChat: () => {},
    bot: {},
    utils: { getPlayerEntity: () => ({}) },
    isCombatSessionActive: () => true,
    stopAttackSilent: async () => { throw new Error('interrupt failed') },
    combatLifecycle: { waitUntilInactive: async () => {} }
  }

  const res = await dispatchCommand(ctx, parsed, { username: 'Tester', raw: 'follow' })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.handled, false)
  assert.strictEqual(res.logCode, COMMAND_LOG_CODES.COMBAT_INTERRUPT_FAILED)
  console.log('unit-command-policy: OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
