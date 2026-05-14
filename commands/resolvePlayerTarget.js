'use strict'

/**
 * Resolve movement/defend targets from parsed commands (sender vs quoted nick).
 * Pure helpers — no movement / pathfinding.
 */

/**
 * @param {string} senderUsername
 * @param {{ getPlayerEntity: (u: string) => any }} utils
 */
function resolveSenderEntity (utils, senderUsername) {
  if (!utils || typeof utils.getPlayerEntity !== 'function') return null
  return utils.getPlayerEntity(senderUsername)
}

/**
 * @param {Record<string, string>} args from parsePlayerMessage (e.g. quotedPlayer)
 * @returns {string|null}
 */
function resolveQuotedPlayerName (args) {
  const n = args && args.quotedPlayer
  if (n == null || String(n).trim() === '') return null
  return String(n).trim()
}

/**
 * @param {{ targetMode: string, args?: Record<string, string> }} parsed
 * @param {string} senderUsername
 * @param {{ getPlayerEntity: (u: string) => any }} utils
 * @returns {{ entity: any | null, username: string | null, mode: string }}
 */
function resolvePlayerTarget (parsed, senderUsername, utils) {
  if (!parsed) {
    return { entity: null, username: null, mode: 'none' }
  }
  if (parsed.targetMode === 'sender') {
    const entity = resolveSenderEntity(utils, senderUsername)
    return { entity, username: senderUsername, mode: 'sender' }
  }
  if (parsed.targetMode === 'quoted_player') {
    const name = resolveQuotedPlayerName(parsed.args || {})
    if (!name) return { entity: null, username: null, mode: 'quoted_player' }
    const entity = resolveSenderEntity(utils, name)
    return { entity, username: name, mode: 'quoted_player' }
  }
  return { entity: null, username: null, mode: parsed.targetMode || 'none' }
}

module.exports = {
  resolvePlayerTarget,
  resolveSenderEntity,
  resolveQuotedPlayerName
}
