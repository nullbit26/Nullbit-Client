'use strict'

const PARTY_PREFIX_ALIASES = /** @type {const} */ (['party', 'friend'])
const PARTY_VERB_ALIASES = /** @type {const} */ (['add', 'remove', 'list', 'clear'])

function escapeRe (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildAlternation (items) {
  return items.map(escapeRe).join('|')
}

const PARTY_PREFIX_RE = buildAlternation(PARTY_PREFIX_ALIASES)
const PARTY_VERB_RE = buildAlternation(PARTY_VERB_ALIASES)
const PARTY_COMMAND_REGEX = new RegExp(`^(${PARTY_PREFIX_RE})\\s+(${PARTY_VERB_RE})(?:\\s+(.*))?$`, 'i')

module.exports = {
  PARTY_PREFIX_ALIASES,
  PARTY_VERB_ALIASES,
  PARTY_COMMAND_REGEX
}
