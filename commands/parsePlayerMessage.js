'use strict'

const { getPlayerCommandRegistry } = require('./commandRegistry')

/**
 * @typedef {'chat' | 'whisper'} CommandSource
 *
 * @typedef {'none' | 'sender' | 'quoted_player'} TargetMode
 *
 * @typedef {{
 *   command: string,
 *   args: Record<string, string>,
 *   targetMode: TargetMode,
 *   priority: boolean,
 *   interruptsCombat: boolean,
 *   source: CommandSource,
 *   handlerKey: string,
 *   permission: 'may_control_bot'
 * }} ParsedPlayerMessage
 */

/**
 * NFC trim + collapse internal whitespace + lowercase (for normExact only).
 * @param {string} s
 */
function normalizeForMatch (s) {
  return String(s || '')
    .trim()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * @param {import('./commandRegistry').CommandRegistryEntry} entry
 * @param {string} norm
 * @param {string} rawTrim
 * @returns {Record<string, string> | null}
 */
function matchEntryPatterns (entry, norm, rawTrim) {
  for (const p of entry.patterns) {
    if (p.type === 'normExact') {
      if (norm === p.value) return {}
    } else if (p.type === 'rawRegex') {
      const m = rawTrim.match(p.re)
      if (m && typeof p.argsFrom === 'function') return p.argsFrom(m)
      if (m && !p.argsFrom) return {}
    }
  }
  return null
}

/**
 * Parse a player message into a normalized command or `null` if it is not a registered player command.
 * Does not use substring / `includes` matching — only explicit patterns from the registry.
 *
 * @param {string} rawMessage
 * @param {{ source?: CommandSource, defendCapable?: boolean }} [opts]
 * @returns {ParsedPlayerMessage | null}
 */
function parsePlayerMessage (rawMessage, opts = {}) {
  const source = opts.source || 'chat'
  const defendCapable = opts.defendCapable !== false

  const rawTrim = String(rawMessage || '').trim()
  if (!rawTrim) return null

  const norm = normalizeForMatch(rawTrim)

  for (const entry of getPlayerCommandRegistry()) {
    if (entry.requireDefend && !defendCapable) continue
    const args = matchEntryPatterns(entry, norm, rawTrim)
    if (!args) continue

    return {
      command: entry.command,
      args: args || {},
      targetMode: entry.targetMode,
      priority: entry.priority,
      interruptsCombat: entry.interruptsCombat,
      source,
      handlerKey: entry.handlerKey,
      permission: entry.permission
    }
  }

  return null
}

module.exports = {
  parsePlayerMessage,
  normalizeForMatch
}
