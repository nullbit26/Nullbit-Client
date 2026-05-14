'use strict'

if (typeof process.stdout?.setDefaultEncoding === 'function') process.stdout.setDefaultEncoding('utf8')
if (typeof process.stderr?.setDefaultEncoding === 'function') process.stderr.setDefaultEncoding('utf8')

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')

const config = require('./config')
const { state, resetStuckState } = require('./state')
const createUtils = require('./utils')
const createAI = require('./ai')
const createMovementActions = require('./actions/movement')
const createCombatActions = require('./actions/combat')
const createCraftActions = require('./actions/craft')
const bindBotEvents = require('./events')
const getEnvironment = require('./features/getEnvironment')
const { formatAssistantBriefing } = require('./features/assistantBriefing')
const { BotBrain } = require('./core/BotBrain')
const { GameplayEvents, NavEvents } = require('./core/EventRegistry')
const createDefend = require('./defend')

/** @type {{ shuttingDown: boolean, brain: import('./core/BotBrain').BotBrain | null, bot: import('mineflayer').Bot | null, defend: { stopAllDefend: Function } | null, movementActions: { setModeIdle: Function } | null }} */
const sessionRef = {
  shuttingDown: false,
  brain: null,
  bot: null,
  defend: null,
  movementActions: null
}

let sigintInstalled = false

function installSigintOnce () {
  if (sigintInstalled) return
  sigintInstalled = true
  process.on('SIGINT', () => {
    sessionRef.shuttingDown = true
    if (state.reconnectTimer) {
      try {
        clearTimeout(state.reconnectTimer)
      } catch (_) {}
      state.reconnectTimer = null
    }
    try {
      sessionRef.defend?.stopAllDefend?.({ silent: true })
      sessionRef.movementActions?.setModeIdle?.()
      try {
        sessionRef.brain?.destroy?.('sigint')
      } catch (_) {}
      sessionRef.bot?.quit?.('bye')
    } finally {
      process.exit(0)
    }
  })
}

function wireBrainGameplayListeners (brain, ctx) {
  const bus = brain.eventBus
  const { movementActions, craftActions, log } = ctx

  bus.on(GameplayEvents.CRAFT_GEAR, () => {
    void craftActions.craftGear().catch((e) => log('[intent] craft:', e.message))
  })
  bus.on(GameplayEvents.TOGGLE_FLIGHT, (p) => {
    try {
      movementActions.toggleFlight(!!p.enable)
    } catch (e) {
      log('[intent] flight:', e.message)
    }
  })
}

function toUtf8Text (input) {
  return Buffer.from(String(input ?? ''), 'utf8').toString('utf8').normalize('NFC')
}

function sanitizeVoiceText (input) {
  return toUtf8Text(input)
    .replace(/[^\p{L}\p{N}\s.,!?;:'"()\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function createBotOptions () {
  const o = {
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: config.auth
  }
  const pw = config.mcPassword != null ? String(config.mcPassword).trim() : ''
  if (pw) o.password = pw
  return o
}

function start () {
  installSigintOnce()

  const bot = mineflayer.createBot(createBotOptions())
  sessionRef.bot = bot
  sessionRef.shuttingDown = false

  bot.loadPlugin(pathfinder)

  bot.once('inject_allowed', () => {
    bot.pathfinder.thinkTimeout = config.pathThinkTimeoutMs
    bot.pathfinder.tickTimeout = config.pathTickTimeoutMs

    const { Movements } = require('mineflayer-pathfinder')
    const movements = new Movements(bot)

    const dangerBlockNames = [
      'lava',
      'flowing_lava',
      'fire',
      'soul_fire',
      'magma_block',
      'campfire',
      'soul_campfire',
      'cactus',
      'sweet_berry_bush',
      'wither_rose',
      'tripwire',
      'tripwire_hook',
      'TNT',
      'tnt',
      'moving_piston',
      'nether_portal',
      'end_portal',
      'cobweb',
      'powder_snow'
    ]

    for (const name of dangerBlockNames) {
      const block = bot.registry.blocksByName[name]
      if (block?.id) movements.blocksToAvoid.add(block.id)
    }

    const cantBreakNames = ['tripwire', 'tripwire_hook', 'tnt', 'TNT']
    for (const name of cantBreakNames) {
      const block = bot.registry.blocksByName[name]
      if (block?.id) movements.blocksCantBreak.add(block.id)
    }

    bot.pathfinder.setMovements(movements)

    bot.on('blockUpdate', (oldBlock, newBlock) => {
      if (!newBlock) return
      const dangerNames = ['lava', 'flowing_lava', 'fire']
      if (!dangerNames.some((n) => newBlock.name?.includes(n))) return
      const dist = bot.entity.position.distanceTo(newBlock.position)
      if (dist >= 10) return
      console.log('[Pathfinder] Опасный блок рядом — пересчёт маршрута')
      const g = bot.pathfinder.goal
      if (g) bot.pathfinder.setGoal(g)
    })
  })

  const utils = createUtils(bot)

  const brain = new BotBrain(bot, {
    config,
    utils,
    navigation: true
  })
  sessionRef.brain = brain

  const { PartyIFFSystem } = require('./systems/PartyIFFSystem')
  const partyIFF = new PartyIFFSystem({ bot, config, brain })
  brain.partyIFF = partyIFF
  bot.partyIFF = partyIFF
  partyIFF.init()

  const movementActions = createMovementActions(bot, { config, state, utils, resetStuckState })
  sessionRef.movementActions = movementActions
  const defend = createDefend(bot, {
    voice: brain.voice,
    utils,
    setModeIdle: movementActions.setModeIdle,
    getCoreState: () => brain.state.getState(),
    eventBus: brain.eventBus,
    NavEvents,
    brain
  })
  sessionRef.defend = defend
  const combatActions = createCombatActions(bot, {
    config,
    state,
    utils,
    movementActions,
    resetStuckState,
    defend
  })

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

  const ai = createAI(bot, {
    config,
    state,
    utils,
    brain,
    actions: {
      setModeIdle: movementActions.setModeIdle,
      setModeFollow: movementActions.setModeFollow,
      setModeCome: movementActions.setModeCome,
      gotoNearCoords: movementActions.gotoNearCoords,
      toggleFlight: movementActions.toggleFlight,
      craftGear: craftActions.craftGear,
      getEnvironment: () => getEnvironment(bot),
      patrolMode: (opts) => defend.patrolMode(opts || {}),
      defendPoint: (opts) => defend.defendPoint(opts || {}),
      defendEntity: (opts) => defend.defendEntity(opts || {}),
      defendStop: () => {
        defend.stopAllDefend()
        return { ok: true }
      }
    }
  })

  brain.attachAwarenessSystem({
    voice: brain.voice,
    ai,
    log: utils.log,
    scanEnvironment: getEnvironment.scanEnvironment,
    getEnvironment,
    getAssistantBriefing: () => formatAssistantBriefing(bot, state)
  })

  brain.attachGameplaySystems({
    bot,
    config,
    state,
    utils,
    movementActions,
    combatActions,
    defend,
    reconnect: {
      schedule: () => {
        start()
      },
      isShuttingDown: () => sessionRef.shuttingDown
    }
  })

  wireBrainGameplayListeners(brain, {
    movementActions,
    craftActions,
    log: utils.log
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
    voice: brain.voice,
    defend,
    eventBus: brain.eventBus,
    partyIFF,
    brain
  })

  bot.on('end', () => {
    try {
      brain.destroy('bot_end')
    } catch (_) {}
  })

  bot.once('spawn', () => {
    state.reconnectAttempts = 0
    if (state.reconnectTimer) {
      try {
        clearTimeout(state.reconnectTimer)
      } catch (_) {}
      state.reconnectTimer = null
    }
    try {
      brain.init()
    } catch (e) {
      utils.log('[brain] init failed:', e.message)
    }
    try {
      if (bot.voiceChat && typeof bot.voiceChat.connect === 'function') bot.voiceChat.connect()
    } catch (_) {}
    const startupVoiceText = sanitizeVoiceText(
      'Система МИНИ КОШ инициализирована. Голосовая связь установлена. Готов к выполнению задач, мяу!'
    )
    console.log('TEXT FOR VOICE:', startupVoiceText)
    brain.voice
      .speak(startupVoiceText)
      .catch(() => {})
  })
}

module.exports = { start }
