'use strict'
const { PARTY_COMMAND_REGEX } = require('./aliasTable')

/**
 * Single source of truth for player-typed chat commands (Phase B router).
 *
 * @typedef {'none' | 'sender' | 'quoted_player'} TargetMode
 * @typedef {'may_control_bot'} PermissionKey
 *
 * @typedef {{
 *   type: 'normExact',
 *   value: string
 * }} NormExactPattern
 *
 * @typedef {{
 *   type: 'rawRegex',
 *   re: RegExp,
 *   argsFrom?: (m: RegExpMatchArray) => Record<string, string>
 * }} RawRegexPattern
 *
 * @typedef {{
 *   command: string,
 *   handlerKey: string,
 *   targetMode: TargetMode,
 *   permission: PermissionKey,
 *   interruptsCombat: boolean,
 *   priority: boolean,
 *   requireDefend: boolean,
 *   patterns: (NormExactPattern | RawRegexPattern)[]
 * }} CommandRegistryEntry
 */

/** @type {CommandRegistryEntry[]} Order matters: first match wins (longer / more specific entries first). */
const PLAYER_COMMAND_REGISTRY = [
  {
    command: 'party_manage',
    handlerKey: 'legacy.partyIFF',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [
      {
        type: 'rawRegex',
        re: PARTY_COMMAND_REGEX,
        argsFrom: (m) => ({
          partyVerb: String(m[2] || '').toLowerCase(),
          partyRest: String(m[3] || '').trim()
        })
      }
    ]
  },
  {
    command: 'defend_entity',
    handlerKey: 'legacy.defendEntity',
    targetMode: 'quoted_player',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: true,
    patterns: [
      {
        type: 'rawRegex',
        re: /^(?:защищай|охраняй|дефай)\s+"([^"]+)"\s*$/i,
        argsFrom: (m) => ({ quotedPlayer: String(m[1] || '').trim() })
      },
      {
        type: 'rawRegex',
        re: /^(?:защищай|охраняй|дефай)\s+\u00ab([^\u00bb]+)\u00bb\s*$/i,
        argsFrom: (m) => ({ quotedPlayer: String(m[1] || '').trim() })
      }
    ]
  },
  {
    command: 'defend_entity',
    handlerKey: 'legacy.defendEntity',
    targetMode: 'sender',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: true,
    patterns: [
      { type: 'normExact', value: 'дефай меня' },
      { type: 'normExact', value: 'защищай меня' },
      { type: 'normExact', value: 'охраняй меня' }
    ]
  },
  {
    command: 'defend_point',
    handlerKey: 'legacy.defendPoint',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: true,
    patterns: [
      { type: 'normExact', value: 'охраняй тут' },
      { type: 'normExact', value: 'защищай точку' },
      { type: 'normExact', value: 'дефай точку' }
    ]
  },
  {
    command: 'cancel_defend',
    handlerKey: 'legacy.cancelDefend',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [{ type: 'normExact', value: 'отмена защиты' }]
  },
  {
    command: 'path_status',
    handlerKey: 'legacy.pathStatus',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [{ type: 'normExact', value: 'статус пути' }]
  },
  {
    command: 'craft_gear',
    handlerKey: 'legacy.craftGear',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [{ type: 'normExact', value: 'скрафти снарягу' }]
  },
  {
    command: 'heal_self',
    handlerKey: 'legacy.misc',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [
      { type: 'normExact', value: 'полечись' },
      { type: 'normExact', value: 'лечись' },
      { type: 'normExact', value: 'heal' },
      { type: 'normExact', value: 'heal up' }
    ]
  },
  {
    command: 'attack_direct',
    handlerKey: 'legacy.attackDirect',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [
      {
        type: 'rawRegex',
        re: /^(?:бросай|снимай|отмени)\s+защиту\s+и\s+(?:атакуй|бей)\s+"([^"]+)"\s*$/i,
        argsFrom: (m) => ({ attackKind: 'player', playerName: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:бросай|снимай|отмени)\s+защиту\s+и\s+(?:атакуй|бей)\s+\u00ab([^\u00bb]+)\u00bb\s*$/i,
        argsFrom: (m) => ({ attackKind: 'player', playerName: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:бросай|снимай|отмени)\s+защиту\s+и\s+(?:атакуй|бей)\s+(?:the\s+)?(?:nearest|closest)(?:\s+(.+?))?\s*$/i,
        argsFrom: (m) => ({ attackKind: 'nearest', mobHint: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:бросай|снимай|отмени)\s+защиту\s+и\s+(?:атакуй|бей)\s+ближайш(?:ий|ая|ое|его|ему|им|их|ую|ие|шего|шей|шему|шим)?(?:\s+(.+))?\s*$/i,
        argsFrom: (m) => ({ attackKind: 'nearest', mobHint: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:бросай|снимай|отмени)\s+защиту\s+и\s+(?:атакуй|бей)\s+(.+)$/i,
        argsFrom: (m) => ({ attackKind: 'typed', mobQuery: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:drop|cancel)\s+defend\s+and\s+attack\s+"([^"]+)"\s*$/i,
        argsFrom: (m) => ({ attackKind: 'player', playerName: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:drop|cancel)\s+defend\s+and\s+attack\s+(?:the\s+)?(?:nearest|closest)(?:\s+(.+?))?\s*$/i,
        argsFrom: (m) => ({ attackKind: 'nearest', mobHint: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:drop|cancel)\s+defend\s+and\s+attack\s+(.+)$/i,
        argsFrom: (m) => ({ attackKind: 'typed', mobQuery: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:принудительно|форс|force)\s+(?:атакуй|бей|attack)\s+"([^"]+)"\s*$/i,
        argsFrom: (m) => ({ attackKind: 'player', playerName: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей|attack)\s+(?:принудительно|форс|force)\s+"([^"]+)"\s*$/i,
        argsFrom: (m) => ({ attackKind: 'player', playerName: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:принудительно|форс|force)\s+(?:атакуй|бей|attack)\s+\u00ab([^\u00bb]+)\u00bb\s*$/i,
        argsFrom: (m) => ({ attackKind: 'player', playerName: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей|attack)\s+(?:принудительно|форс|force)\s+\u00ab([^\u00bb]+)\u00bb\s*$/i,
        argsFrom: (m) => ({ attackKind: 'player', playerName: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:принудительно|форс|force)\s+(?:атакуй|бей|attack)\s+(?:the\s+)?(?:nearest|closest)(?:\s+(.+?))?\s*$/i,
        argsFrom: (m) => ({ attackKind: 'nearest', mobHint: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей|attack)\s+(?:принудительно|форс|force)\s+(?:the\s+)?(?:nearest|closest)(?:\s+(.+?))?\s*$/i,
        argsFrom: (m) => ({ attackKind: 'nearest', mobHint: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:принудительно|форс|force)\s+(?:атакуй|бей)\s+ближайш(?:ий|ая|ое|его|ему|им|их|ую|ие|шего|шей|шему|шим)?(?:\s+(.+))?\s*$/i,
        argsFrom: (m) => ({ attackKind: 'nearest', mobHint: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей)\s+(?:принудительно|форс|force)\s+ближайш(?:ий|ая|ое|его|ему|им|их|ую|ие|шего|шей|шему|шим)?(?:\s+(.+))?\s*$/i,
        argsFrom: (m) => ({ attackKind: 'nearest', mobHint: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:принудительно|форс|force)\s+(?:атакуй|бей|attack)\s+(.+)$/i,
        argsFrom: (m) => ({ attackKind: 'typed', mobQuery: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей|attack)\s+(?:принудительно|форс|force)\s+(.+)$/i,
        argsFrom: (m) => ({ attackKind: 'typed', mobQuery: String(m[1] || '').trim(), defendOverride: '1' })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей|attack)\s+"([^"]+)"\s*$/i,
        argsFrom: (m) => ({ attackKind: 'player', playerName: String(m[1] || '').trim() })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей|attack)\s+\u00ab([^\u00bb]+)\u00bb\s*$/i,
        argsFrom: (m) => ({ attackKind: 'player', playerName: String(m[1] || '').trim() })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей|attack)\s+(?:the\s+)?(?:nearest|closest)(?:\s+(.+?))?\s*$/i,
        argsFrom: (m) => ({ attackKind: 'nearest', mobHint: String(m[1] || '').trim() })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей)\s+ближайш(?:ий|ая|ое|его|ему|им|их|ую|ие|шего|шей|шему|шим)?(?:\s+(.+))?\s*$/i,
        argsFrom: (m) => ({ attackKind: 'nearest', mobHint: String(m[1] || '').trim() })
      },
      {
        type: 'rawRegex',
        re: /^атакуй\s*$/i,
        argsFrom: () => ({ attackKind: 'bare' })
      },
      {
        type: 'rawRegex',
        re: /^бей\s*$/i,
        argsFrom: () => ({ attackKind: 'bare' })
      },
      {
        type: 'rawRegex',
        re: /^attack\s*$/i,
        argsFrom: () => ({ attackKind: 'bare' })
      },
      {
        type: 'rawRegex',
        re: /^(?:атакуй|бей|attack)\s+(.+)$/i,
        argsFrom: (m) => ({ attackKind: 'typed', mobQuery: String(m[1] || '').trim() })
      }
    ]
  },
  {
    command: 'survival_off',
    handlerKey: 'legacy.survivalOff',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [
      { type: 'normExact', value: 'не выживай' },
      { type: 'normExact', value: 'перестань выживать' },
      { type: 'normExact', value: 'stop survival' },
      { type: 'normExact', value: 'стоп выживание' }
    ]
  },
  {
    command: 'survival_on',
    handlerKey: 'legacy.survivalOn',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [
      { type: 'normExact', value: 'выживай' },
      { type: 'normExact', value: 'survive' }
    ]
  },
  {
    command: 'stop',
    handlerKey: 'legacy.movement',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: true,
    priority: true,
    requireDefend: false,
    patterns: [
      { type: 'normExact', value: 'stop' },
      { type: 'normExact', value: 'stop attack' },
      { type: 'normExact', value: 'idle' },
      { type: 'normExact', value: 'стой' },
      { type: 'normExact', value: 'стоп' },
      { type: 'normExact', value: 'стоп атаку' },
      { type: 'normExact', value: 'прекрати' }
    ]
  },
  {
    command: 'come',
    handlerKey: 'legacy.movement',
    targetMode: 'sender',
    permission: 'may_control_bot',
    interruptsCombat: true,
    priority: true,
    requireDefend: false,
    patterns: [
      { type: 'normExact', value: 'come' },
      { type: 'normExact', value: 'ко мне' },
      { type: 'normExact', value: 'сюда' },
      { type: 'normExact', value: 'иди ко мне' }
    ]
  },
  {
    command: 'follow',
    handlerKey: 'legacy.movement',
    targetMode: 'sender',
    permission: 'may_control_bot',
    interruptsCombat: true,
    priority: true,
    requireDefend: false,
    patterns: [
      { type: 'normExact', value: 'follow' },
      { type: 'normExact', value: 'иди за мной' },
      { type: 'normExact', value: 'за мной' },
      { type: 'normExact', value: 'следуй за мной' }
    ]
  },
  {
    command: 'guard',
    handlerKey: 'legacy.movement',
    targetMode: 'sender',
    permission: 'may_control_bot',
    interruptsCombat: true,
    priority: true,
    requireDefend: false,
    patterns: [
      { type: 'normExact', value: 'guard' },
      { type: 'normExact', value: 'охраняй' },
      { type: 'normExact', value: 'защищай' }
    ]
  },
  {
    command: 'inv',
    handlerKey: 'legacy.inventory',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [
      { type: 'normExact', value: 'inv' },
      { type: 'normExact', value: 'inventory' },
      { type: 'normExact', value: 'инв' },
      { type: 'normExact', value: 'инвентарь' }
    ]
  },
  {
    command: 'dump',
    handlerKey: 'legacy.inventory',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: true,
    priority: true,
    requireDefend: false,
    patterns: [
      { type: 'normExact', value: 'dump' },
      { type: 'normExact', value: 'dropall' },
      { type: 'normExact', value: 'выбрось' },
      { type: 'normExact', value: 'выброси все' },
      { type: 'normExact', value: 'мусор' }
    ]
  },
  {
    command: 'drop_item_qty',
    handlerKey: 'legacy.inventory',
    targetMode: 'none',
    permission: 'may_control_bot',
    interruptsCombat: false,
    priority: true,
    requireDefend: false,
    patterns: [
      {
        type: 'rawRegex',
        re: /^(?:выброси|выбрось|drop)\s+(\d+)\s+(.+)$/i,
        argsFrom: (m) => ({
          quantity: String(m[1] || '').trim(),
          itemQuery: String(m[2] || '').trim()
        })
      }
    ]
  }
]

function getPlayerCommandRegistry () {
  return PLAYER_COMMAND_REGISTRY
}

module.exports = {
  getPlayerCommandRegistry,
  PLAYER_COMMAND_REGISTRY
}
