'use strict'

const assert = require('assert')
const { parsePlayerMessage } = require('../commands/parsePlayerMessage')
const { resolveAttackTarget } = require('../commands/resolveAttackTarget')
const { applyCombatPolicy } = require('../commands/runCommandHooks')
const { COMMAND_LOG_CODES } = require('../commands/commandLogCodes')
const { CoreStates } = require('../core/StateManager')
const { IFF } = require('../systems/PartyIFFSystem')

function vec (x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo (o) {
      const dx = x - o.x
      const dy = y - o.y
      const dz = z - o.z
      return Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
  }
}

function mockParty (iffById) {
  return {
    getEffectiveIFF (e) {
      return iffById[e.id] || IFF.HOSTILE
    }
  }
}

async function main () {
  const p1 = parsePlayerMessage('attack zombie', { defendCapable: true })
  assert.ok(p1 && p1.command === 'attack_direct' && p1.args.attackKind === 'typed')
  const p2 = parsePlayerMessage('attack nearest', { defendCapable: true })
  assert.ok(p2 && p2.args.attackKind === 'nearest')
  const p3 = parsePlayerMessage('атакуй ближайшего крипера', { defendCapable: true })
  assert.ok(p3 && p3.args.attackKind === 'nearest' && /creep|крип/i.test(p3.args.mobHint))

  const pForce = parsePlayerMessage('принудительно атакуй зомби', { defendCapable: true })
  assert.ok(pForce && pForce.args.defendOverride === '1' && pForce.args.mobQuery === 'зомби')
  const pForce2 = parsePlayerMessage('attack force nearest', { defendCapable: true })
  assert.ok(pForce2 && pForce2.args.defendOverride === '1' && pForce2.args.attackKind === 'nearest')

  const cfg = { commandAttackMaxDistanceBlocks: 32, commandAttackAmbiguityEpsilonBlocks: 1.5 }
  const bot = {
    entity: { position: vec(0, 64, 0), id: 1 },
    entities: {
      10: { id: 10, type: 'mob', name: 'zombie', position: vec(5, 64, 0), health: 20 },
      11: { id: 11, type: 'mob', name: 'zombie', position: vec(5.5, 64, 0), health: 20 },
      12: { id: 12, type: 'mob', name: 'creeper', position: vec(2, 64, 0), health: 20 },
      13: { id: 13, type: 'mob', name: 'creeper', position: vec(40, 64, 0), health: 20 }
    }
  }

  const parsedOverride = {
    command: 'attack_direct',
    interruptsCombat: false,
    args: { defendOverride: '1', attackKind: 'typed', mobQuery: 'zombie' }
  }

  const pBare = parsePlayerMessage('атакуй', { defendCapable: true })
  assert.ok(pBare && pBare.command === 'attack_direct' && pBare.args.attackKind === 'bare')
  const pDrop = parsePlayerMessage('бросай защиту и атакуй зомби', { defendCapable: true })
  assert.ok(pDrop && pDrop.args.defendOverride === '1' && pDrop.args.mobQuery === 'зомби')
  const pDropEn = parsePlayerMessage('drop defend and attack creeper', { defendCapable: true })
  assert.ok(pDropEn && pDropEn.args.defendOverride === '1' && /creeper/i.test(pDropEn.args.mobQuery))

  const bareRes = resolveAttackTarget({
    bot,
    partyIFF: mockParty({}),
    config: cfg,
    args: { attackKind: 'bare' }
  })
  assert.ok(!bareRes.ok && bareRes.code === 'attack_target_required')

  const selfEnt = { id: 1, position: vec(0, 64, 0), type: 'player', username: 'Bot', health: 20 }
  const noHostileWorld = {
    entity: selfEnt,
    entities: { 1: selfEnt }
  }
  const nnf = resolveAttackTarget({
    bot: noHostileWorld,
    partyIFF: mockParty({}),
    config: cfg,
    args: { attackKind: 'nearest', mobHint: '' }
  })
  assert.ok(!nnf.ok && nnf.code === 'target_not_found')

  const selfFar = { id: 1, position: vec(0, 64, 0), type: 'player', username: 'Bot', health: 20 }
  const farHostile = {
    entity: selfFar,
    entities: {
      1: selfFar,
      50: { id: 50, type: 'mob', name: 'zombie', position: vec(80, 64, 0), health: 20 }
    }
  }
  const nnv = resolveAttackTarget({
    bot: farHostile,
    partyIFF: mockParty({}),
    config: cfg,
    args: { attackKind: 'nearest', mobHint: '' }
  })
  assert.ok(!nnv.ok && nnv.code === 'target_not_visible')

  const deadZ = resolveAttackTarget({
    bot: {
      entity: { position: vec(0, 64, 0), id: 1 },
      entities: {
        10: { id: 10, type: 'mob', name: 'zombie', position: vec(4, 64, 0), health: 0 }
      }
    },
    partyIFF: mockParty({}),
    config: cfg,
    args: { attackKind: 'typed', mobQuery: 'zombie' }
  })
  assert.ok(!deadZ.ok && deadZ.code === 'target_not_found')

  const { handleAttackDirect } = require('../commands/handlers/combat')
  let stopCalled = false
  const soloZBot = {
    entity: { position: vec(0, 64, 0), id: 1 },
    entities: {
      1: { id: 1, position: vec(0, 64, 0), type: 'player', username: 'Bot', health: 20 },
      10: { id: 10, type: 'mob', name: 'zombie', position: vec(5, 64, 0), health: 20 }
    }
  }
  const ctxHandler = {
    eventBus: { emit () {} },
    defend: {
      isDefendActive: () => true,
      stopAllDefend () {
        stopCalled = true
      }
    },
    bot: soloZBot,
    partyIFF: mockParty({}),
    config: cfg,
    log: () => {}
  }
  const rHandler = await handleAttackDirect(ctxHandler, {
    command: 'attack_direct',
    args: { defendOverride: '1', attackKind: 'typed', mobQuery: 'zombie' }
  }, {})
  assert.ok(stopCalled && rHandler.logCode === COMMAND_LOG_CODES.ATTACK_DEFEND_OVERRIDE)
  assert.ok(String(rHandler.response?.text || '').includes('Снял охрану'))

  const gateCombatOverride = await applyCombatPolicy(
    {
      isCombatSessionActive: () => true,
      getCoreState: () => CoreStates.IDLE,
      defend: { isDefendActive: () => true },
      config: { commandAttackDefendOverrideEnabled: true }
    },
    parsedOverride
  )
  assert.ok(gateCombatOverride && gateCombatOverride.logCode === COMMAND_LOG_CODES.COMBAT_BUSY)

  const nearest = resolveAttackTarget({
    bot,
    partyIFF: mockParty({}),
    config: cfg,
    args: { attackKind: 'nearest', mobHint: '' }
  })
  assert.ok(nearest.ok && nearest.entityName === 'creeper')

  const amb = resolveAttackTarget({
    bot,
    partyIFF: mockParty({}),
    config: cfg,
    args: { attackKind: 'typed', mobQuery: 'zombie' }
  })
  assert.ok(!amb.ok && amb.code === 'target_ambiguous')

  const far = resolveAttackTarget({
    bot: {
      entity: { position: vec(0, 64, 0), id: 1 },
      entities: {
        14: { id: 14, type: 'mob', name: 'creeper', position: vec(40, 64, 0), health: 20 }
      }
    },
    partyIFF: mockParty({}),
    config: cfg,
    args: { attackKind: 'typed', mobQuery: 'creeper' }
  })
  assert.ok(!far.ok && far.code === 'target_not_visible')

  const partyBot = {
    entity: { position: vec(0, 64, 0), id: 1 },
    entities: {
      20: { id: 20, type: 'player', username: 'Ally', position: vec(3, 64, 0), health: 20 }
    }
  }
  const friendly = resolveAttackTarget({
    bot: partyBot,
    partyIFF: mockParty({ 20: IFF.FRIEND }),
    config: cfg,
    args: { attackKind: 'player', playerName: 'Ally' }
  })
  assert.ok(!friendly.ok && friendly.code === 'friendly_target')

  const parsedAttack = { command: 'attack_direct', interruptsCombat: false }
  const gateCombat = await applyCombatPolicy(
    {
      isCombatSessionActive: () => true,
      getCoreState: () => CoreStates.IDLE,
      defend: { isDefendActive: () => false }
    },
    parsedAttack
  )
  assert.ok(gateCombat && gateCombat.logCode === COMMAND_LOG_CODES.COMBAT_BUSY)

  const gateFlee = await applyCombatPolicy(
    {
      isCombatSessionActive: () => false,
      getCoreState: () => CoreStates.FLEE,
      defend: { isDefendActive: () => false }
    },
    parsedAttack
  )
  assert.ok(gateFlee && gateFlee.logCode === COMMAND_LOG_CODES.COMBAT_BUSY)

  const gateFleeOverride = await applyCombatPolicy(
    {
      isCombatSessionActive: () => false,
      getCoreState: () => CoreStates.FLEE,
      defend: { isDefendActive: () => true },
      config: { commandAttackDefendOverrideEnabled: true }
    },
    parsedOverride
  )
  assert.ok(gateFleeOverride && gateFleeOverride.logCode === COMMAND_LOG_CODES.COMBAT_BUSY)

  const gateDef = await applyCombatPolicy(
    {
      isCombatSessionActive: () => false,
      getCoreState: () => CoreStates.IDLE,
      defend: { isDefendActive: () => true },
      config: { commandAttackDefendOverrideEnabled: true }
    },
    parsedAttack
  )
  assert.ok(gateDef && gateDef.logCode === COMMAND_LOG_CODES.DEFEND_ACTIVE)

  const gateDefPass = await applyCombatPolicy(
    {
      isCombatSessionActive: () => false,
      getCoreState: () => CoreStates.IDLE,
      defend: { isDefendActive: () => true },
      config: { commandAttackDefendOverrideEnabled: true }
    },
    parsedOverride
  )
  assert.strictEqual(gateDefPass, null)

  const gateDefOverrideOff = await applyCombatPolicy(
    {
      isCombatSessionActive: () => false,
      getCoreState: () => CoreStates.IDLE,
      defend: { isDefendActive: () => true },
      config: { commandAttackDefendOverrideEnabled: false }
    },
    parsedOverride
  )
  assert.ok(gateDefOverrideOff && gateDefOverrideOff.logCode === COMMAND_LOG_CODES.DEFEND_ACTIVE)

  console.log('unit-resolve-attack-target: OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
