'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { parsePlayerMessage } = require('../commands/parsePlayerMessage')
const { MovementEvents } = require('../core/EventRegistry')
const { handleCome } = require('../commands/handlers/movement')

async function main () {
  const a = parsePlayerMessage('ко мне', { defendCapable: true })
  const b = parsePlayerMessage('сюда', { defendCapable: true })
  assert.ok(a && b)
  assert.strictEqual(a.command, 'come')
  assert.strictEqual(b.command, 'come')
  assert.strictEqual(a.handlerKey, b.handlerKey)

  let setComeCount = 0
  const ctx = {
    eventBus: {
      emit (ev, payload) {
        if (ev === MovementEvents.SET_COME) setComeCount++
      }
    },
    movementActions: { setModeCome () {} }
  }
  const target = { entity: { position: { x: 0, y: 64, z: 0 } } }
  await handleCome(ctx, null, { username: 'Player1', target })
  await handleCome(ctx, null, { username: 'Player1', target })
  assert.strictEqual(setComeCount, 2, 'повторный come не должен подавляться в handler')

  const pf = fs.readFileSync(
    path.join(__dirname, '..', 'node_modules', 'mineflayer-pathfinder', 'index.js'),
    'utf8'
  )
  assert.ok(
    pf.includes('come/repath: clear pending pathfinder.stop'),
    'ожидается фикс setGoal/stopPathing в mineflayer-pathfinder (npm i / node scripts/apply-pathfinder-patch.js)'
  )

  console.log('unit-come-repeat: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
