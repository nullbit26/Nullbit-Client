'use strict'

/**
 * Public chat + whisper: who may run movement / party / defend / inventory commands.
 * Matches legacy events.js rules: party members (PartyIFF) OR config.allowedUsers (empty = open).
 *
 * @param {string} username
 * @param {{ allowedUsers?: string[] }} config
 * @param {{ isPartyUsername?: (name: string) => boolean } | null | undefined} partyIFF
 */
function mayControlBot (username, config, partyIFF) {
  if (partyIFF && typeof partyIFF.isPartyUsername === 'function' && partyIFF.isPartyUsername(username)) return true
  const list = config?.allowedUsers
  if (!Array.isArray(list) || list.length === 0) return true
  return list.includes(username)
}

const { parsePlayerMessage } = require('../commands/parsePlayerMessage')

/**
 * True if the message is a registered player command (parser-based, no substring `includes`).
 * Caller should still gate on `mayControlBot` before enqueueing.
 *
 * @param {{ raw: string, source?: import('../commands/parsePlayerMessage').CommandSource, defendCapable?: boolean }} p
 */
function shouldEnqueueChatWhileBusy (p) {
  const raw = String(p.raw || '').trim()
  const source = p.source || 'chat'
  const defendCapable = p.defendCapable !== false
  return parsePlayerMessage(raw, { source, defendCapable }) != null
}

module.exports = {
  mayControlBot,
  shouldEnqueueChatWhileBusy
}
