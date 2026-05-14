'use strict'

const { CombatEvents } = require('../../core/EventRegistry')
const { handledWithMessage, rejectWithMessage } = require('../handlerResult')
const { COMMAND_LOG_CODES } = require('../commandLogCodes')
const { resolveAttackTarget } = require('../resolveAttackTarget')

/** @param {string} code */
function messageForResolveCode (code) {
  switch (code) {
    case 'no_position':
      return { text: 'Не знаю свою позицию — не могу выбрать цель.', logCode: COMMAND_LOG_CODES.NO_POSITION }
    case 'iff_missing':
      return { text: 'Внутренняя ошибка: нет фильтра целей (IFF).', logCode: COMMAND_LOG_CODES.TARGET_RESOLUTION_FAILED }
    case 'attack_target_required':
      return {
        text: 'Нужно указать цель: например зомби, ближайшего крипера, nearest, игрока в кавычках.',
        logCode: COMMAND_LOG_CODES.ATTACK_TARGET_REQUIRED
      }
    case 'target_not_found':
      return { text: 'Такой цели рядом нет.', logCode: COMMAND_LOG_CODES.TARGET_NOT_FOUND }
    case 'target_not_visible':
      return { text: 'Не вижу подходящую цель в пределах дистанции.', logCode: COMMAND_LOG_CODES.TARGET_NOT_VISIBLE }
    case 'target_ambiguous':
      return { text: 'Несколько одинаково близких целей — уточни, кого бить.', logCode: COMMAND_LOG_CODES.TARGET_AMBIGUOUS }
    case 'friendly_target':
      return { text: 'Эту цель атаковать не буду (союзник или не враг).', logCode: COMMAND_LOG_CODES.FRIENDLY_TARGET }
    default:
      return { text: 'Не удалось выбрать цель для атаки.', logCode: COMMAND_LOG_CODES.TARGET_RESOLUTION_FAILED }
  }
}

/** @param {any} ctx @param {import('../parsePlayerMessage').ParsedPlayerMessage} parsed */
async function handleAttackDirect (ctx, parsed, _exec) {
  if (!ctx.eventBus || typeof ctx.eventBus.emit !== 'function') {
    return rejectWithMessage('Шина событий недоступна — атака по команде не работает.', {
      logCode: COMMAND_LOG_CODES.DISPATCH_ERROR,
      retryable: true
    })
  }

  const hadDefendOverride = String(parsed.args?.defendOverride || '') === '1'
  let stoppedDefendForAttack = false
  if (hadDefendOverride && ctx.defend?.isDefendActive?.()) {
    try {
      ctx.defend.stopAllDefend({ silent: true })
      stoppedDefendForAttack = true
    } catch (e) {
      ctx.log('[attack_direct] stopAllDefend:', e?.message || e)
    }
  }

  const resolved = resolveAttackTarget({
    bot: ctx.bot,
    partyIFF: ctx.partyIFF,
    config: ctx.config,
    args: parsed.args || {}
  })

  if (!resolved.ok) {
    const { text, logCode } = messageForResolveCode(resolved.code)
    return rejectWithMessage(text, { logCode, retryable: !!resolved.retryable })
  }

  const at = Date.now()
  const payload = {
    entityName: resolved.entityName,
    strategy: 'aggressive',
    at
  }
  if (resolved.entityId != null) payload.entityId = resolved.entityId
  ctx.eventBus.emit(CombatEvents.ENGAGE_ENTITY, payload)

  const logCode = stoppedDefendForAttack ? COMMAND_LOG_CODES.ATTACK_DEFEND_OVERRIDE : COMMAND_LOG_CODES.OK
  const text = stoppedDefendForAttack
    ? `Снял охрану. Атакую ${resolved.labelRu}.`
    : `Атакую ${resolved.labelRu}.`
  return handledWithMessage(text, { logCode })
}

const COMBAT_COMMAND_HANDLERS = {
  attack_direct: handleAttackDirect
}

module.exports = {
  COMBAT_COMMAND_HANDLERS,
  handleAttackDirect
}
