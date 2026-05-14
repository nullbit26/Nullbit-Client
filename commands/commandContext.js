'use strict'

const { stopAttack } = require('../attackEntity')
const { isCombatSessionActive } = require('../attackEntity')
const { buildInventorySummary, dumpUnwantedItems, tossItemByQuery } = require('../features/inventoryChatCommands')
const { trySelfHealFromInventory } = require('../features/selfHealCommand')
const { onCombatSessionActiveChanged } = require('../combat/session/sessionFlags')
const { waitUntilCombatInactive } = require('../combat/session/waitCombatInactive')

/**
 * Runtime bundle for command handlers (built once per `bindBotEvents`).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Record<string, any>} deps — same shape as `bindBotEvents(bot, deps)`
 * @param {{ safeChat: (t: string) => void, log: (...a: any[]) => void }} io
 */
function createCommandContext (bot, deps, io) {
  const {
    config,
    state,
    utils,
    voice,
    eventBus,
    movementActions,
    combatActions,
    craftActions,
    defend,
    partyIFF,
    brain
  } = deps
  const { craftGear } = craftActions
  const { log, safeChat } = io

  return {
    bot,
    config,
    state,
    utils,
    voice,
    eventBus,
    defend,
    partyIFF,
    brain: brain || null,
    getCoreState: () => (brain?.state?.getState ? brain.state.getState() : null),
    movementActions,
    combatActions,
    log,
    safeChat,
    craft: { craftGear },
    features: {
      buildInventorySummary: () => buildInventorySummary(bot),
      dumpUnwantedItems: () => dumpUnwantedItems(bot),
      tossItemByQuery: (qty, query) => tossItemByQuery(bot, qty, query),
      trySelfHealFromInventory: (hpThreshold) => trySelfHealFromInventory(bot, hpThreshold),
      getFrontBlock: utils.getFrontBlock,
      getFeetBlock: utils.getFeetBlock
    },
    async stopAttackSilent () {
      await stopAttack(bot, voice, { silent: true }).catch(() => {})
    },
    isCombatSessionActive: () => isCombatSessionActive(),
    combatLifecycle: {
      subscribeActiveChanged: onCombatSessionActiveChanged,
      waitUntilInactive: async (maxMs = 1000) => {
        await waitUntilCombatInactive({
          isActive: () => isCombatSessionActive(),
          subscribeActiveChanged: onCombatSessionActiveChanged,
          maxMs,
          sleepMs: 80
        })
      }
    }
  }
}

module.exports = { createCommandContext }
