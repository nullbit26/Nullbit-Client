'use strict'

const fs = require('fs')
const path = require('path')
const { HOSTILE_MOB } = require('../features/getEnvironment')

/** @typedef {'FRIEND' | 'NEUTRAL' | 'PROVOKABLE' | 'HOSTILE'} IFFKind */

const IFF = /** @type {const} */ ({
  FRIEND: 'FRIEND',
  NEUTRAL: 'NEUTRAL',
  PROVOKABLE: 'PROVOKABLE',
  HOSTILE: 'HOSTILE'
})

const STATIC_FRIEND_MOBS = new Set([
  'villager',
  'wandering_trader',
  'iron_golem',
  'snow_golem'
])

const NEUTRAL_PASSIVE = new Set(['cow', 'sheep'])

const PROVOKABLE_NAMES = new Set(['enderman', 'zombified_piglin', 'wolf', 'spider', 'cave_spider'])

const LEGACY_CHAT_FRIENDS = path.join(__dirname, '..', 'data', 'combat-friends-chat.json')
const PARTY_DATA = path.join(__dirname, '..', 'data', 'party.json')
const { mayControlBot } = require('../utils/commandChatAccess')
const { PARTY_COMMAND_REGEX } = require('../commands/aliasTable')

const AGGRO_TTL_MS = 120_000

/** @param {import('mineflayer').Bot} bot */
function isWorldBrightForSpider (bot) {
  try {
    const pos = bot.entity?.position
    if (pos && typeof bot.world?.getSkyLight === 'function') {
      const sky = bot.world.getSkyLight(pos)
      if (sky != null) return sky >= 12
    }
  } catch (_) {}
  const t = bot.time?.timeOfDay
  if (t == null) return true
  const phase = t % 24000
  return phase < 12_300 || phase > 23_400
}

/**
 * @param {any} entity
 * @param {import('mineflayer').Bot} bot
 * @param {Set<string>} partyLower
 * @returns {IFFKind}
 */
function baseMobIFF (entity, bot, partyLower) {
  const n = (entity?.name || '').toLowerCase()
  if (!n) return IFF.HOSTILE

  if (STATIC_FRIEND_MOBS.has(n)) return IFF.FRIEND

  if (NEUTRAL_PASSIVE.has(n)) return IFF.NEUTRAL

  if (n === 'spider' || n === 'cave_spider') {
    return isWorldBrightForSpider(bot) ? IFF.PROVOKABLE : IFF.HOSTILE
  }

  if (PROVOKABLE_NAMES.has(n)) return IFF.PROVOKABLE

  if (HOSTILE_MOB.has(n)) return IFF.HOSTILE

  if (entity?.type === 'mob' || entity?.type === 'hostile') return IFF.HOSTILE

  return IFF.NEUTRAL
}

/**
 * @param {any} entity
 * @param {import('mineflayer').Bot} bot
 * @param {Set<string>} partyLower
 */
function basePlayerIFF (entity, partyLower) {
  const u = (entity?.username || '').trim().toLowerCase()
  if (!u) return IFF.HOSTILE
  if (partyLower.has(u)) return IFF.FRIEND
  return IFF.HOSTILE
}

/**
 * @param {string} s
 */
function normName (s) {
  return String(s || '').trim().toLowerCase()
}

function safeReply (text) {
  return Buffer.from(String(text || ''), 'utf8')
    .toString('utf8')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s.,!?;:'"()\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

/**
 * Party list + IFF for combat, defend, awareness. Replaces legacy combatFriends.
 * Temporary hostility from damage is stored on {@link ../memory/OperationalMemory} (`recordThreat`);
 * {@link ../systems/AwarenessSystem} calls `markAggroFromDamage` from `entityHurt` when `source` is present.
 */
class PartyIFFSystem {
  /**
   * @param {{ bot: import('mineflayer').Bot, config: any, brain?: import('../core/BotBrain').BotBrain }} ctx
   */
  constructor (ctx) {
    if (!ctx?.bot) throw new Error('[PartyIFFSystem] bot is required')
    if (!ctx?.config) throw new Error('[PartyIFFSystem] config is required')
    this.bot = ctx.bot
    this.config = ctx.config
    this.brain = ctx.brain || null

    /** @private @type {Set<string>} */
    this._party = new Set()
    /** @private @type {Map<number, number>} entity id -> expiresAt when `brain.memory` is absent (tests) */
    this._fallbackAggro = new Map()

    /** @private */
    this._wired = false
    /** @private */
    this._onWhisper = this._onWhisper.bind(this)

    this.loadPartyFromDisk()
  }

  loadPartyFromDisk () {
    this._party.clear()
    const fileExists = fs.existsSync(PARTY_DATA)
    if (fileExists) {
      try {
        const j = JSON.parse(fs.readFileSync(PARTY_DATA, 'utf8'))
        for (const x of Array.isArray(j.party) ? j.party : []) {
          const n = normName(x)
          if (n) this._party.add(n)
        }
      } catch (_) {}
      return
    }

    try {
      if (fs.existsSync(LEGACY_CHAT_FRIENDS)) {
        const j = JSON.parse(fs.readFileSync(LEGACY_CHAT_FRIENDS, 'utf8'))
        for (const x of Array.isArray(j.friends) ? j.friends : []) {
          const n = normName(x)
          if (n) this._party.add(n)
        }
      }
    } catch (_) {}

    const seed = this.config.partySeedUsers || []
    for (const x of seed) {
      const n = normName(x)
      if (n) this._party.add(n)
    }
    this.persistParty()
  }

  persistParty () {
    try {
      fs.mkdirSync(path.dirname(PARTY_DATA), { recursive: true })
      fs.writeFileSync(
        PARTY_DATA,
        JSON.stringify({ party: Array.from(this._party).sort() }, null, 2),
        'utf8'
      )
    } catch (_) {}
  }

  /** @param {string} name */
  isPartyUsername (name) {
    return this._party.has(normName(name))
  }

  /** Same as legacy `isCombatFriend` for players. */
  isNonHostilePlayer (name) {
    return this.isPartyUsername(name)
  }

  _mem () {
    return this.brain?.memory || null
  }

  purgeExpiredAggro () {
    const now = Date.now()
    const mem = this._mem()
    if (mem && typeof mem.purgeExpiredThreats === 'function') {
      mem.purgeExpiredThreats(now)
    }
    for (const [id, until] of this._fallbackAggro) {
      if (until <= now) this._fallbackAggro.delete(id)
    }
  }

  /**
   * @param {any} entity
   * @returns {boolean}
   */
  isAggroMarked (entity) {
    if (!entity || entity.id == null) return false
    this.purgeExpiredAggro()
    const id = typeof entity.id === 'number' ? entity.id : Number(entity.id)
    if (!Number.isFinite(id)) return false
    const mem = this._mem()
    const now = Date.now()
    if (mem && typeof mem.isThreatEntityActive === 'function') {
      return mem.isThreatEntityActive(id, now)
    }
    const until = this._fallbackAggro.get(id)
    return typeof until === 'number' && until > now
  }

  /**
   * @param {any} victim
   * @param {any} attacker
   */
  markAggroFromDamage (victim, attacker) {
    if (!victim || !attacker || victim === attacker) return
    if (victim.id != null && attacker.id != null && victim.id === attacker.id) return
    if (attacker === this.bot.entity || attacker?.id === this.bot.entity?.id) return

    const party = this._party
    const attackerName = (attacker.username || '').trim().toLowerCase()
    if (attackerName && party.has(attackerName)) return

    let victimIsSide = false
    if (victim === this.bot.entity || victim?.id === this.bot.entity?.id) {
      victimIsSide = true
    } else if (victim.type === 'player' && victim.username) {
      if (party.has(victim.username.trim().toLowerCase())) victimIsSide = true
    } else {
      const vIFF = baseMobIFF(victim, this.bot, party)
      if (vIFF === IFF.FRIEND) victimIsSide = true
    }

    if (!victimIsSide) return

    const aid = typeof attacker.id === 'number' ? attacker.id : Number(attacker.id)
    if (!Number.isFinite(aid)) return

    const now = Date.now()
    let protectedTargetType = 'friend_mob'
    let protectedTargetIdOrName = ''
    if (victim === this.bot.entity || victim?.id === this.bot.entity?.id) {
      protectedTargetType = 'bot'
      protectedTargetIdOrName = String(this.bot.username || 'bot')
    } else if (victim.type === 'player' && victim.username) {
      protectedTargetType = 'party_player'
      protectedTargetIdOrName = victim.username.trim().toLowerCase()
    } else {
      const vid = victim.id != null ? String(victim.id) : ''
      const vname = (victim.name || '').toLowerCase()
      protectedTargetIdOrName = (vid || vname || 'unknown').slice(0, 96)
    }

    const mem = this._mem()
    if (mem && typeof mem.recordThreat === 'function') {
      mem.recordThreat({
        entityId: aid,
        reason: 'damaged_protected_target',
        protectedTargetType,
        protectedTargetIdOrName,
        lastSeenAt: now,
        expiresAt: now + AGGRO_TTL_MS
      })
    } else {
      this._fallbackAggro.set(aid, now + AGGRO_TTL_MS)
    }
  }

  /**
   * @param {any} entity
   * @returns {IFFKind}
   */
  getEffectiveIFF (entity) {
    this.purgeExpiredAggro()
    if (!entity) return IFF.HOSTILE
    if (this.isAggroMarked(entity)) return IFF.HOSTILE

    if (entity.type === 'player') {
      return basePlayerIFF(entity, this._party)
    }

    return baseMobIFF(entity, this.bot, this._party)
  }

  /**
   * Entities the bot should treat as dangerous (flee, warn, defend against).
   * @param {number} maxDist
   * @returns {{ entity: any, d: number, name: string, id: number, iff: IFFKind }[]}
   */
  listThreatsWithin (maxDist) {
    if (!this.bot.entity?.position) return []
    const pos = this.bot.entity.position
    const out = []
    for (const e of Object.values(this.bot.entities || {})) {
      if (!e?.position || e === this.bot.entity) continue
      const iff = this.getEffectiveIFF(e)
      if (iff !== IFF.HOSTILE) continue
      const d = pos.distanceTo(e.position)
      if (d > maxDist) continue
      const n = (e.name || e.username || '').toLowerCase()
      const id = typeof e.id === 'number' ? e.id : Number(e.id)
      out.push({
        entity: e,
        d,
        name: n || 'unknown',
        id: Number.isFinite(id) ? id : -1,
        iff
      })
    }
    out.sort((a, b) => a.d - b.d)
    return out
  }

  /**
   * Used by defend `findThreat`: may target players (non-party) and HOSTILE mobs (including aggro).
   * @param {any} entity
   * @param {{ excludeNames?: Set<string> }} [opts]
   */
  isDefenseThreatEntity (entity, opts = {}) {
    if (!entity || entity === this.bot.entity) return false
    if (entity.health !== undefined && entity.health <= 0) return false
    const exclude = opts.excludeNames || new Set()
    const disp = entity.displayName == null || entity.displayName === '' ? '' : String(entity.displayName)
    const nameLower = (entity.username || entity.name || disp).toString().trim().toLowerCase()
    if (!nameLower) return false
    if (exclude.has(nameLower)) return false
    if (nameLower === (this.bot.username || '').toLowerCase()) return false

    if (entity.type === 'player') {
      if (this.isPartyUsername(nameLower)) return false
      return this.getEffectiveIFF(entity) === IFF.HOSTILE
    }

    if (entity.type === 'mob' || entity.type === 'hostile') {
      const iff = this.getEffectiveIFF(entity)
      return iff === IFF.HOSTILE
    }
    return false
  }

  /**
   * @param {string} username — command sender
   * @param {string} raw — full message
   * @returns {boolean} true if this was a party command (handled or failed parse)
   */
  tryHandleChatCommand (username, raw) {
    const t = String(raw || '').trim()
    const m = t.match(PARTY_COMMAND_REGEX)
    if (!m) return false
    if (!mayControlBot(username, this.config, this)) {
      this.bot.chat(safeReply('Party: permission denied.'))
      return true
    }

    const verb = m[2].toLowerCase()
    const rest = (m[3] || '').trim()
    const names = rest.length ? rest.split(/\s+/).map((s) => s.trim()).filter(Boolean) : []

    const self = (this.bot.username || '').toLowerCase()

    if (verb === 'list') {
      const list = Array.from(this._party).sort()
      const msg =
        list.length === 0
          ? 'Party is empty.'
          : `Party (${list.length}): ${list.join(', ')}`.slice(0, 240)
      this.bot.chat(safeReply(msg))
      return true
    }

    if (verb === 'clear') {
      this._party.clear()
      this.persistParty()
      this.bot.chat(safeReply('Party cleared.'))
      return true
    }

    if (verb === 'add') {
      if (!names.length) {
        this.bot.chat(safeReply('Usage: party add <name1> [name2] ...'))
        return true
      }
      const added = []
      const skipped = []
      for (const rawName of names) {
        const low = normName(rawName)
        if (!low || low.length > 32) {
          skipped.push(rawName)
          continue
        }
        if (low === self) {
          skipped.push(rawName)
          continue
        }
        if (this._party.has(low)) {
          skipped.push(rawName)
          continue
        }
        this._party.add(low)
        added.push(rawName)
      }
      this.persistParty()
      let msg = ''
      if (added.length) {
        msg = `Added ${added.length} player(s) to the party: ${added.join(', ')}`
      }
      if (skipped.length && !added.length) {
        msg = `No players added (already in party or invalid): ${skipped.join(', ')}`.slice(0, 240)
      } else if (skipped.length) {
        msg += ` Skipped: ${skipped.join(', ')}`.slice(0, 240)
      }
      this.bot.chat(safeReply(msg || 'Nothing to add.'))
      return true
    }

    if (verb === 'remove') {
      if (!names.length) {
        this.bot.chat(safeReply('Usage: party remove <name1> [name2] ...'))
        return true
      }
      const removed = []
      const missing = []
      for (const rawName of names) {
        const low = normName(rawName)
        if (!low) continue
        if (this._party.has(low)) {
          this._party.delete(low)
          removed.push(rawName)
        } else missing.push(rawName)
      }
      this.persistParty()
      let msg = ''
      if (removed.length) {
        msg = `Removed ${removed.length} player(s) from the party: ${removed.join(', ')}`
      }
      if (missing.length && !removed.length) {
        msg = `None of those players were in the party: ${missing.join(', ')}`.slice(0, 240)
      } else if (missing.length) {
        msg += ` Not in party: ${missing.join(', ')}`.slice(0, 240)
      }
      this.bot.chat(safeReply(msg || 'Nothing to remove.'))
      return true
    }

    return true
  }

  /** @private @param {string} username @param {string} message */
  _onWhisper (username, message) {
    if (!username || username === this.bot.username) return
    if (!mayControlBot(username, this.config, this)) return
    this.tryHandleChatCommand(username, String(message || ''))
  }

  init () {
    if (this._wired) return
    this._wired = true
    this.bot.on('whisper', this._onWhisper)
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this.bot.removeListener('whisper', this._onWhisper)
    this._fallbackAggro.clear()
  }
}

module.exports = { PartyIFFSystem, IFF }
