/**
 * Smoke test: verifies module graph and DI wiring match index.js (no Minecraft connection).
 * Run: npm run smoke:di
 */
'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')

const config = require('../config')
const { isPathBreakAllowed, isPathfinderBreakAllowed } = require('../natural-dig-policy')
const { state, resetStuckState } = require('../state')
const createUtils = require('../utils')
const createAI = require('../ai')
const createMovementActions = require('../actions/movement')
const createCombatActions = require('../actions/combat')
const createCraftActions = require('../actions/craft')
const createDefend = require('../defend')
const bindBotEvents = require('../events')
const { mayControlBot, shouldEnqueueChatWhileBusy } = require('../utils/commandChatAccess')
const { parsePlayerMessage } = require('../commands/parsePlayerMessage')
const {
  routeLegacyPhase,
  LEGACY_PHASE,
  dispatchCommand,
  listDispatchedCommandNames
} = require('../commands/dispatchCommand')
const { createCommandContext } = require('../commands/commandContext')
const { COMMAND_LOG_CODES } = require('../commands/commandLogCodes')
const { COMMAND_POLICY_MATRIX } = require('../commands/commandPolicy')
const { DELIVERY_CHANNELS } = require('../commands/deliveryPolicy')
const { PARTY_COMMAND_REGEX, PARTY_PREFIX_ALIASES } = require('../commands/aliasTable')
const { waitUntilCombatInactive } = require('../combat/session/waitCombatInactive')

function createMockBot() {
  const bot = new EventEmitter()
  bot.username = 'SmokeBot'
  bot.version = config.version || '1.21.1'

  const pos = {
    x: 0,
    y: 64,
    z: 0,
    clone() {
      return { ...this, clone: this.clone }
    },
    offset(dx, dy, dz) {
      return {
        x: this.x + dx,
        y: this.y + dy,
        z: this.z + dz,
        clone: () => ({ x: this.x + dx, y: this.y + dy, z: this.z + dz, clone() { return this } }),
        offset: (ax, ay, az) => this.offset(dx + ax, dy + ay, dz + az)
      }
    },
    distanceTo(other) {
      const dx = other.x - this.x
      const dy = other.y - this.y
      const dz = other.z - this.z
      return Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
  }

  bot.entity = {
    position: pos,
    height: 1.62,
    yaw: 0,
    pitch: 0,
    onGround: true,
    isCollidedHorizontally: false,
    isInWater: false,
    velocity: { x: 0, y: 0, z: 0 }
  }

  bot.health = 20
  bot.food = 20

  bot.inventory = {
    items: () => [],
    slots: { 5: null, 6: null, 7: null, 8: null }
  }

  bot.players = {}
  bot.entities = {}

  bot.pathfinder = {
    setMovements: () => {},
    setGoal: () => {},
    stop: () => {},
    goal: null,
    isMoving: () => false,
    isMining: () => false,
    skipPathSteps: () => 0,
    pausePathExecution: () => {},
    pathStepAt: () => null,
    goto: async () => {}
  }

  bot.controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }
  bot.setControlState = (name, val) => {
    if (bot.controlState && name in bot.controlState) bot.controlState[name] = !!val
  }
  bot.clearControlStates = () => {
    for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false
  }

  bot.world = {
    raycast: () => null
  }

  bot.blockAt = () => ({ name: 'air' })

  bot.chat = () => {}

  bot.findBlock = () => null

  bot.equip = async () => {}

  bot.placeBlock = async () => {}

  bot.waitForTicks = async () => {}

  bot.recipesFor = () => []

  bot.craft = async () => {}

  bot.nearestEntity = () => null

  bot.quit = () => {}

  return bot
}

function wireLikeIndex(bot) {
  const utils = createUtils(bot)
  const brainStub = {
    pushIntent () {},
    state: { getState: () => 'IDLE' }
  }
  const movementActions = createMovementActions(bot, { config, state, utils, resetStuckState })

  let currentMcData = null
  const originalSetMcData = movementActions.setMcData
  movementActions.setMcData = (version) => {
    currentMcData = originalSetMcData(version)
    return currentMcData
  }

  const craftActions = createCraftActions(bot, {
    utils,
    getMcData: () => currentMcData
  })

  const defend = createDefend(bot, {
    voice: { speak: async () => {} },
    utils,
    setModeIdle: movementActions.setModeIdle
  })
  const combatActions = createCombatActions(bot, {
    config,
    state,
    utils,
    movementActions,
    resetStuckState,
    defend
  })

  const ai = createAI(bot, {
    config,
    state,
    utils,
    brain: brainStub,
    actions: {
      setModeIdle: movementActions.setModeIdle,
      setModeFollow: movementActions.setModeFollow,
      setModeCome: movementActions.setModeCome,
      gotoNearCoords: movementActions.gotoNearCoords,
      toggleFlight: movementActions.toggleFlight,
      craftGear: craftActions.craftGear
    }
  })

  bindBotEvents(bot, {
    config,
    state,
    resetStuckState,
    utils,
    ai,
    movementActions,
    combatActions,
    craftActions,
    voice: { speak: async () => {} }
  })

  bot.emit('inject_allowed')

  return { utils, movementActions, combatActions, craftActions, ai, getMcData: () => currentMcData }
}

async function main() {
  assert.strictEqual(typeof config.host, 'string', 'config.host')
  assert.ok(Array.isArray(config.allowedUsers), 'config.allowedUsers')
  assert.strictEqual(isPathBreakAllowed('stone'), true, 'barrier policy may still treat stone as diggable type')
  assert.strictEqual(isPathfinderBreakAllowed('stone'), false, 'pathfinder must not plan mining raw stone')
  assert.strictEqual(isPathfinderBreakAllowed('dirt'), true)

  const bot = createMockBot()
  const { movementActions, combatActions, craftActions, ai, utils } = wireLikeIndex(bot)

  assert.strictEqual(typeof movementActions.setupMovements, 'function')
  assert.strictEqual(typeof movementActions.refreshScaffoldingBlocks, 'function')
  assert.strictEqual(typeof movementActions.setModeFollow, 'function')
  assert.strictEqual(typeof movementActions.setModeCome, 'function')
  assert.strictEqual(typeof movementActions.repathToTarget, 'function')
  assert.strictEqual(typeof movementActions.handleAntiStuck, 'function')
  assert.strictEqual(typeof movementActions.tickPathStallEscape, 'function')
  assert.strictEqual(typeof movementActions.toggleFlight, 'function')
  assert.strictEqual(typeof movementActions.recordNavProgress, 'function')
  assert.strictEqual(typeof movementActions.onPathfinderUpdate, 'function')
  assert.strictEqual(typeof movementActions.resetObstacleRecovery, 'function')
  assert.strictEqual(typeof movementActions.tickNavAssist, 'function')

  assert.strictEqual(typeof combatActions.setModeGuard, 'function')
  assert.strictEqual(typeof combatActions.handleGuardCombat, 'function')

  assert.strictEqual(typeof craftActions.craftGear, 'function')

  assert.strictEqual(typeof ai.askAssistant, 'function')
  assert.strictEqual(typeof ai.initThread, 'function')
  assert.strictEqual(ai.parseCommand('стой'), 'stop')
  assert.strictEqual(ai.parseCommand('стоп'), 'stop')
  assert.strictEqual(ai.parseCommand('следуй за мной'), 'follow')
  assert.strictEqual(ai.parseCommand('за мной'), 'follow')
  assert.strictEqual(ai.parseCommand('иди за мной'), 'follow')
  assert.strictEqual(ai.parseCommand('ко мне'), 'come')
  assert.strictEqual(ai.parseCommand('инв'), 'inv')
  assert.strictEqual(ai.parseCommand('мусор'), 'dump')
  assert.strictEqual(ai.parseCommand('выброси все'), 'dump')
  assert.strictEqual(ai.parseCommand('выброси 3 камень'), 'drop_item_qty')
  assert.strictEqual(ai.parseCommand('drop 2 cobblestone'), 'drop_item_qty')
  assert.strictEqual(ai.parseCommand('подготовься к бою'), null)
  assert.strictEqual(ai.parseCommand('дефай меня'), 'defend_entity')
  assert.strictEqual(ai.parseCommand('скрафти снарягу'), 'craft_gear')
  assert.strictEqual(ai.parseCommand('полечись'), 'heal_self')
  assert.strictEqual(ai.parseCommand('иди ко мне на спавн'), null, 'no substring come match')
  const ctx = ai.getBotContext()
  assert.ok(ctx.includes('Режим:'), 'getBotContext should mention mode (briefing)')

  movementActions.setModeIdle()
  assert.strictEqual(state.mode, 'idle')

  const dispatched = listDispatchedCommandNames()
  for (const k of [
    'follow',
    'stop',
    'guard',
    'inv',
    'dump',
    'drop_item_qty',
    'come',
    'defend_entity',
    'craft_gear',
    'heal_self',
    'party_manage'
  ]) {
    assert.ok(dispatched.includes(k), `dispatch table should include ${k}`)
  }

  movementActions.setModeFollow('SmokeUser')
  assert.strictEqual(state.mode, 'follow')
  const cmdCtx = createCommandContext(
    bot,
    {
      config,
      state,
      utils,
      voice: { speak: async () => {} },
      eventBus: null,
      movementActions,
      combatActions,
      craftActions,
      defend: null,
      partyIFF: null
    },
    { safeChat: () => {}, log: () => {} }
  )
  const stopResult = await dispatchCommand(cmdCtx, parsePlayerMessage('стоп', { defendCapable: true }), {
    username: 'SmokeUser',
    raw: 'стоп'
  })
  assert.strictEqual(stopResult.ok, true, 'dispatch stop ok')
  assert.strictEqual(stopResult.handled, true, 'dispatch stop')
  assert.strictEqual(stopResult.logCode, COMMAND_LOG_CODES.IDLE_SET, 'dispatch stop logCode')
  assert.strictEqual(state.mode, 'idle', 'stop handler clears mode')
  movementActions.setModeIdle()

  const invResult = await dispatchCommand(cmdCtx, parsePlayerMessage('инв', { defendCapable: true }), {
    username: 'SmokeUser',
    raw: 'инв'
  })
  assert.strictEqual(invResult.ok, true, 'dispatch inv ok')
  assert.strictEqual(invResult.handled, true, 'dispatch inv handled')
  assert.strictEqual(invResult.response?.channel, DELIVERY_CHANNELS.WHISPER_PREFERRED, 'inv keeps whisper-preferred behavior')

  // combat-active policy scenario: interruptsCombat command fails when interrupt fails
  const combatBusyCtx = {
    ...cmdCtx,
    isCombatSessionActive: () => true,
    stopAttackSilent: async () => { throw new Error('interrupt failure') },
    combatLifecycle: { waitUntilInactive: async () => {} }
  }
  const combatPolicyResult = await dispatchCommand(
    combatBusyCtx,
    parsePlayerMessage('follow', { defendCapable: true }),
    { username: 'SmokeUser', raw: 'follow' }
  )
  assert.strictEqual(combatPolicyResult.ok, false, 'combat policy should reject on interrupt failure')
  assert.strictEqual(combatPolicyResult.handled, false)
  assert.strictEqual(combatPolicyResult.logCode, COMMAND_LOG_CODES.COMBAT_INTERRUPT_FAILED)

  // policy matrix sanity for migrated commands
  assert.strictEqual(COMMAND_POLICY_MATRIX.follow.interruptsCombat, true)
  assert.strictEqual(COMMAND_POLICY_MATRIX.inv.interruptsCombat, false)

  assert.ok(bot.listenerCount('spawn') >= 1, 'spawn listener registered')
  assert.ok(bot.listenerCount('physicsTick') >= 2, 'physicsTick early + nav-assist (after inject_allowed)')
  assert.ok(bot.listenerCount('chat') >= 1, 'chat listener registered')

  const pParty = parsePlayerMessage('party list', { defendCapable: true })
  assert.ok(pParty && pParty.command === 'party_manage' && pParty.priority === true)
  assert.strictEqual(parsePlayerMessage('hello party list', { defendCapable: true }), null)
  assert.ok(PARTY_COMMAND_REGEX.test('party list'))
  assert.ok(PARTY_COMMAND_REGEX.test('friend add Steve'))
  assert.ok(PARTY_PREFIX_ALIASES.includes('party') && PARTY_PREFIX_ALIASES.includes('friend'))

  const pStopMw = parsePlayerMessage('стоп атаку', { defendCapable: true })
  assert.ok(pStopMw && pStopMw.command === 'stop' && pStopMw.interruptsCombat === true)
  const pStopEn = parsePlayerMessage('stop attack', { defendCapable: true })
  assert.ok(pStopEn && pStopEn.command === 'stop')
  assert.strictEqual(parsePlayerMessage('please stop moving', { defendCapable: true }), null)

  const pFollow = parsePlayerMessage('следуй за мной', { defendCapable: true })
  assert.ok(pFollow && pFollow.command === 'follow' && pFollow.targetMode === 'sender')
  assert.strictEqual(routeLegacyPhase(pFollow), LEGACY_PHASE.MOVEMENT)

  const pDefNo = parsePlayerMessage('дефай меня', { defendCapable: false })
  assert.strictEqual(pDefNo, null, 'defend phrases skipped when defendCapable false')

  const pQuoted = parsePlayerMessage('охраняй "Steve"', { defendCapable: true })
  assert.ok(
    pQuoted &&
      pQuoted.command === 'defend_entity' &&
      pQuoted.args.quotedPlayer === 'Steve' &&
      pQuoted.targetMode === 'quoted_player'
  )

  const partyIFFStub = { isPartyUsername: (n) => String(n) === 'PartyOnly' }
  assert.strictEqual(mayControlBot('PartyOnly', { allowedUsers: ['Admin'] }, partyIFFStub), true)
  assert.strictEqual(mayControlBot('Stranger', { allowedUsers: ['Admin'] }, partyIFFStub), false)
  assert.strictEqual(mayControlBot('Admin', { allowedUsers: ['Admin'] }, partyIFFStub), true)
  assert.strictEqual(mayControlBot('Anyone', { allowedUsers: [] }, null), true)

  assert.strictEqual(shouldEnqueueChatWhileBusy({ raw: 'стоп', defendCapable: true }), true)
  assert.strictEqual(shouldEnqueueChatWhileBusy({ raw: 'как дела', defendCapable: true }), false)
  assert.strictEqual(shouldEnqueueChatWhileBusy({ raw: 'дефай меня', defendCapable: true }), true)
  assert.strictEqual(shouldEnqueueChatWhileBusy({ raw: 'дефай меня', defendCapable: false }), false)

  let pollSteps = 0
  await waitUntilCombatInactive({
    isActive: () => pollSteps++ < 2,
    maxMs: 5000,
    sleep: async () => {}
  })
  assert.ok(pollSteps >= 2, 'waitUntilCombatInactive should poll until inactive')

  console.log(new Date().toISOString(), '-', 'smoke-di: OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
