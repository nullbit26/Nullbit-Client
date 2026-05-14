'use strict'

/**
 * @typedef {import('./parsePlayerMessage').ParsedPlayerMessage} ParsedPlayerMessage
 */

const { applyCombatPolicy, resolveCommandTarget } = require('./runCommandHooks')
const { MOVEMENT_COMMAND_HANDLERS } = require('./handlers/movement')
const { INVENTORY_COMMAND_HANDLERS } = require('./handlers/inventory')
const { DEFEND_COMMAND_HANDLERS } = require('./handlers/defend')
const { COMBAT_COMMAND_HANDLERS } = require('./handlers/combat')
const { MISC_COMMAND_HANDLERS } = require('./handlers/misc')
const { SURVIVAL_COMMAND_HANDLERS } = require('./handlers/survival')
const { tryHandlePartyManage } = require('./handlers/party')
const { normalizeHandlerResult, notHandled } = require('./handlerResult')
const { sendDispatchResponse } = require('./responseRouter')
const { COMMAND_LOG_CODES } = require('./commandLogCodes')

const LEGACY_PHASE = /** @type {const} */ ({
  PARTY: 'party',
  MOVEMENT: 'movement',
  INVENTORY: 'inventory',
  DEFEND: 'defend',
  MISC: 'misc'
})

/** @type {Record<string, (ctx: any, parsed: ParsedPlayerMessage, exec: any) => any>} */
const COMMAND_HANDLERS = {
  ...MOVEMENT_COMMAND_HANDLERS,
  ...INVENTORY_COMMAND_HANDLERS,
  ...DEFEND_COMMAND_HANDLERS,
  ...COMBAT_COMMAND_HANDLERS,
  ...MISC_COMMAND_HANDLERS,
  ...SURVIVAL_COMMAND_HANDLERS
}

/**
 * Map registry handlerKey → coarse phase (logging / tests).
 * @param {ParsedPlayerMessage | null} parsed
 * @returns {keyof typeof LEGACY_PHASE | null}
 */
function routeLegacyPhase (parsed) {
  if (!parsed) return null
  switch (parsed.handlerKey) {
    case 'legacy.partyIFF':
      return LEGACY_PHASE.PARTY
    case 'legacy.movement':
      return LEGACY_PHASE.MOVEMENT
    case 'legacy.inventory':
      return LEGACY_PHASE.INVENTORY
    case 'legacy.defendEntity':
    case 'legacy.defendPoint':
      return LEGACY_PHASE.DEFEND
    case 'legacy.cancelDefend':
    case 'legacy.pathStatus':
    case 'legacy.craftGear':
    case 'legacy.attackDirect':
    case 'legacy.survivalOn':
    case 'legacy.survivalOff':
      return LEGACY_PHASE.MISC
    default:
      return LEGACY_PHASE.MISC
  }
}

/**
 * Pre-hooks: `party_manage` skips combat interrupt + target resolution (none).
 * All other commands: optional `interruptsCombat` → `ctx.stopAttackSilent()`, then `resolvePlayerTarget`.
 *
 * @param {any} ctx — from {@link ./commandContext.createCommandContext}
 * @param {ParsedPlayerMessage | null} parsed
 * @param {{ username: string, raw: string }} exec
 * @returns {Promise<{ ok: boolean, handled: boolean, phase: string | null, logCode?: string, retryable?: boolean }>}
 */
async function dispatchCommand (ctx, parsed, exec) {
  if (!parsed) {
    return { ok: true, handled: false, phase: null, logCode: COMMAND_LOG_CODES.NO_PARSED_COMMAND, retryable: false }
  }

  const { username, raw } = exec
  const phase = routeLegacyPhase(parsed)

  try {
    if (parsed.command === 'party_manage') {
      const partyResult = normalizeHandlerResult(tryHandlePartyManage(ctx, parsed, { username, raw }), { phase })
      sendDispatchResponse(ctx, exec, partyResult)
      return Object.assign({ phase }, partyResult)
    }

    const combatGate = await applyCombatPolicy(ctx, parsed)
    if (combatGate) {
      const gated = normalizeHandlerResult(combatGate, { phase })
      sendDispatchResponse(ctx, exec, gated)
      return Object.assign({ phase }, gated)
    }

    const target = resolveCommandTarget(parsed, username, ctx.utils)
    if (parsed.targetMode !== 'none' && !target) {
      const noTarget = normalizeHandlerResult(notHandled(COMMAND_LOG_CODES.TARGET_RESOLUTION_FAILED), { phase })
      return Object.assign({ phase }, noTarget)
    }
    const fn = COMMAND_HANDLERS[parsed.command]
    if (typeof fn !== 'function') {
      ctx.log('[dispatch] no handler for command:', parsed.command, 'handlerKey:', parsed.handlerKey)
      const miss = normalizeHandlerResult(notHandled(COMMAND_LOG_CODES.HANDLER_MISSING), { phase })
      return Object.assign({ phase }, miss)
    }

    const handlerResult = normalizeHandlerResult(await fn(ctx, parsed, { username, raw, target }), { phase })
    sendDispatchResponse(ctx, exec, handlerResult)
    return Object.assign({ phase }, handlerResult)
  } catch (e) {
    ctx.log('[dispatch] command failed:', parsed.command, e?.message || e)
    const fail = normalizeHandlerResult(notHandled(COMMAND_LOG_CODES.DISPATCH_ERROR, { retryable: true }), { phase })
    return Object.assign({ phase }, fail)
  }
}

/**
 * For tests / diagnostics — parsed `command` values that `dispatchCommand` handles
 * (`party_manage` is routed before the handler table).
 */
function listDispatchedCommandNames () {
  return [...Object.keys(COMMAND_HANDLERS), 'party_manage'].filter((v, i, a) => a.indexOf(v) === i).sort()
}

module.exports = {
  LEGACY_PHASE,
  routeLegacyPhase,
  dispatchCommand,
  COMMAND_HANDLERS,
  listDispatchedCommandNames
}
