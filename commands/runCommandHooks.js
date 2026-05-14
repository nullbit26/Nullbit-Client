'use strict'

const { resolvePlayerTarget } = require('./resolvePlayerTarget')
const { getCommandCombatPolicy } = require('./commandPolicy')
const { notHandled, rejectWithMessage } = require('./handlerResult')
const { COMMAND_LOG_CODES } = require('./commandLogCodes')
const { CoreStates } = require('../core/StateManager')

/**
 * @param {any} ctx
 * @param {import('./parsePlayerMessage').ParsedPlayerMessage} parsed
 * @returns {Promise<import('./handlerResult').CommandHandlerResult | null>}
 */
async function applyCombatPolicy (ctx, parsed) {
  if (parsed.command === 'attack_direct') {
    const flee = ctx.getCoreState?.() === CoreStates.FLEE
    const combatSession = !!ctx.isCombatSessionActive?.()
    if (combatSession || flee) {
      return rejectWithMessage('Сейчас занят боем или отступлением — команду атаки не принимаю.', {
        logCode: COMMAND_LOG_CODES.COMBAT_BUSY,
        retryable: true
      })
    }
    const defendOverrideAllowed =
      ctx.config?.commandAttackDefendOverrideEnabled !== false &&
      String(parsed.args?.defendOverride || '') === '1'
    if (ctx.defend?.isDefendActive?.() && !defendOverrideAllowed) {
      const wantsOverride = String(parsed.args?.defendOverride || '') === '1'
      const overrideDisabled = ctx.config?.commandAttackDefendOverrideEnabled === false
      if (wantsOverride && overrideDisabled) {
        return rejectWithMessage(
          'Принудительная атака при охране выключена (COMMAND_ATTACK_DEFEND_OVERRIDE=0).',
          { logCode: COMMAND_LOG_CODES.DEFEND_ACTIVE, retryable: false }
        )
      }
      return rejectWithMessage(
        'Сейчас охраняю. Сними защиту («отмена защиты») или атакуй с override: «бросай защиту и атакуй …», «принудительно атакуй …», `attack force …`.',
        { logCode: COMMAND_LOG_CODES.DEFEND_ACTIVE, retryable: false }
      )
    }
    return null
  }

  const policy = getCommandCombatPolicy(parsed.command, parsed.interruptsCombat)
  const isActive = !!ctx.isCombatSessionActive?.()
  if (!isActive) return null

  if (policy.rejectDuringActiveCombat) {
    return notHandled(COMMAND_LOG_CODES.POLICY_REJECTED, { retryable: false })
  }

  if (policy.waitForCombatEnd) {
    if (ctx.combatLifecycle?.waitUntilInactive) {
      await ctx.combatLifecycle.waitUntilInactive(1500)
    }
    if (ctx.isCombatSessionActive?.()) {
      return notHandled(COMMAND_LOG_CODES.COMBAT_BUSY, { retryable: true })
    }
  }

  if (policy.interruptsCombat) {
    try {
      await ctx.stopAttackSilent()
    } catch (_) {
      return notHandled(COMMAND_LOG_CODES.COMBAT_INTERRUPT_FAILED, { retryable: true })
    }
    if (ctx.combatLifecycle?.waitUntilInactive) {
      await ctx.combatLifecycle.waitUntilInactive(500)
    }
    if (ctx.isCombatSessionActive?.()) {
      return notHandled(COMMAND_LOG_CODES.COMBAT_BUSY, { retryable: true })
    }
  }
  return null
}

/**
 * Party lines skip target resolution (handled inside PartyIFF).
 *
 * @param {import('./parsePlayerMessage').ParsedPlayerMessage} parsed
 * @param {string} senderUsername
 * @param {any} utils
 */
function resolveCommandTarget (parsed, senderUsername, utils) {
  return resolvePlayerTarget(parsed, senderUsername, utils)
}

module.exports = {
  applyCombatPolicy,
  resolveCommandTarget
}
