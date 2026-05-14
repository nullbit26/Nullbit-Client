'use strict'

const { IFF } = require('../systems/PartyIFFSystem')

/**
 * RU chat labels for common mob `entity.name` values (fallback: name with underscores → spaces).
 * @param {any} entity
 */
function entityAttackLabelRu (entity) {
  if (!entity) return 'цель'
  if (entity.type === 'player' && entity.username) return String(entity.username)
  const n = (entity.name || '').toLowerCase()
  const ru = {
    zombie: 'зомби',
    creeper: 'крипера',
    skeleton: 'скелета',
    spider: 'паука',
    cave_spider: 'пещерного паука',
    enderman: 'эндермена',
    witch: 'ведьму',
    slime: 'слайма',
    phantom: 'фантома',
    drowned: 'утопленника',
    husk: 'кадавра',
    stray: 'зимнего скелета',
    pillager: 'налётчика',
    vindicator: 'поборника',
    evoker: 'колдуна',
    ravager: 'разорителя',
    hoglin: 'хоглина',
    piglin: 'пиглина',
    piglin_brute: 'брута-пиглина',
    zombified_piglin: 'зомби-пиглина',
    blaze: 'ифрита',
    ghast: 'гаста',
    magma_cube: 'магмового куба',
    guardian: 'стража',
    elder_guardian: 'древнего стража',
    shulker: 'шалкера',
    silverfish: 'чешуйницу',
    endermite: 'эндермита',
    wolf: 'волка',
    iron_golem: 'железного голема'
  }
  if (ru[n]) return ru[n]
  if (n) return n.replace(/_/g, ' ')
  return 'цель'
}

/** @param {string} raw */
function normalizeMobQueryToken (raw) {
  const t = String(raw || '')
    .trim()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .toLowerCase()
  if (!t) return ''
  const aliases = /** @type {Record<string, string>} */ ({
    зомби: 'zombie',
    крип: 'creeper',
    крипа: 'creeper',
    крипер: 'creeper',
    крипера: 'creeper',
    скелет: 'skeleton',
    скелета: 'skeleton',
    паук: 'spider',
    паука: 'spider',
    эндермен: 'enderman',
    эндермена: 'enderman',
    ведьма: 'witch',
    ведьму: 'witch',
    слайм: 'slime',
    фантом: 'phantom',
    утопленник: 'drowned',
    кадавр: 'husk',
    налётчик: 'pillager',
    разоритель: 'ravager',
    ifrit: 'blaze',
    ифрит: 'blaze',
    ифрита: 'blaze',
    гаст: 'ghast',
    гаста: 'ghast'
  })
  return aliases[t] || t
}

/**
 * @param {any} entity
 * @param {string} queryEn lowercase english token
 */
function mobEntityMatchesQuery (entity, queryEn) {
  if (!entity || entity.type === 'player') return false
  const name = (entity.name || '').toLowerCase()
  if (!name || !queryEn) return false
  if (name === queryEn) return true
  if (name.startsWith(queryEn + '_')) return true
  return false
}

/**
 * @param {any} entity
 * @param {string} playerLower
 */
function playerEntityMatches (entity, playerLower) {
  if (!entity || entity.type !== 'player') return false
  const u = (entity.username || '').trim().toLowerCase()
  return !!u && u === playerLower
}

function isAliveEntity (e) {
  if (!e) return false
  if (e.health !== undefined && e.health !== null && e.health <= 0) return false
  return true
}

function passesV1Visible (bot, entity, maxDist) {
  if (!bot?.entity?.position || !entity?.position) return false
  if (entity === bot.entity) return false
  if (!isAliveEntity(entity)) return false
  const d = bot.entity.position.distanceTo(entity.position)
  if (!Number.isFinite(d) || d > maxDist) return false
  return true
}

/**
 * @param {{ bot: any, partyIFF: any, config: any, args: Record<string, string> }} opts
 * @returns {{ ok: true, entity: any, entityName: string, entityId: number, labelRu: string } | { ok: false, code: string, retryable?: boolean }}
 */
function resolveAttackTarget (opts) {
  const { bot, partyIFF, config, args } = opts
  const maxDist = Math.max(4, Math.min(96, Number(config?.commandAttackMaxDistanceBlocks) || 32))
  const epsilon = Math.max(0.1, Math.min(8, Number(config?.commandAttackAmbiguityEpsilonBlocks) || 1.5))

  if (!bot?.entity?.position) {
    return { ok: false, code: 'no_position', retryable: false }
  }
  if (!partyIFF || typeof partyIFF.getEffectiveIFF !== 'function') {
    return { ok: false, code: 'iff_missing', retryable: false }
  }

  const attackKind = String(args?.attackKind || 'typed').toLowerCase()

  if (attackKind === 'bare') {
    return { ok: false, code: 'attack_target_required', retryable: false }
  }

  const pickWithAmbiguity = (rows) => {
    if (!rows.length) return { ok: false, code: 'target_not_visible', retryable: false }
    rows.sort((a, b) => a.d - b.d)
    if (rows.length >= 2 && Math.abs(rows[0].d - rows[1].d) <= epsilon) {
      return { ok: false, code: 'target_ambiguous', retryable: false }
    }
    const top = rows[0].entity
    const entityName = String(top.username || top.name || 'unknown').toLowerCase()
    const rawId = Number(top.id)
    const entityId = Number.isFinite(rawId) && rawId >= 0 ? rawId : undefined
    return {
      ok: true,
      entity: top,
      entityName: entityName || 'unknown',
      entityId,
      labelRu: entityAttackLabelRu(top)
    }
  }

  const visibleHostileRows = () => {
    const pos = bot.entity.position
    const out = []
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity) continue
      if (!passesV1Visible(bot, e, maxDist)) continue
      const iff = partyIFF.getEffectiveIFF(e)
      if (iff !== IFF.HOSTILE) continue
      const d = pos.distanceTo(e.position)
      out.push({ entity: e, d })
    }
    return out
  }

  if (attackKind === 'player') {
    const playerName = String(args.playerName || args.quotedPlayer || '').trim()
    if (!playerName) return { ok: false, code: 'target_not_found', retryable: false }
    const pl = playerName.toLowerCase()
    let entity = null
    for (const e of Object.values(bot.entities || {})) {
      if (playerEntityMatches(e, pl)) {
        entity = e
        break
      }
    }
    if (!entity) return { ok: false, code: 'target_not_found', retryable: false }
    const iff = partyIFF.getEffectiveIFF(entity)
    if (iff === IFF.FRIEND) return { ok: false, code: 'friendly_target', retryable: false }
    if (iff !== IFF.HOSTILE) return { ok: false, code: 'friendly_target', retryable: false }
    if (!isAliveEntity(entity)) return { ok: false, code: 'target_not_visible', retryable: false }
    if (!passesV1Visible(bot, entity, maxDist)) return { ok: false, code: 'target_not_visible', retryable: false }
    return pickWithAmbiguity([{ entity, d: bot.entity.position.distanceTo(entity.position) }])
  }

  if (attackKind === 'nearest') {
    const hintRaw = String(args.mobHint || '').trim()
    const queryEn = normalizeMobQueryToken(hintRaw)
    let rows = visibleHostileRows()
    if (queryEn) {
      rows = rows.filter((r) => mobEntityMatchesQuery(r.entity, queryEn))
    }
    if (!rows.length && queryEn) {
      let anyName = false
      let anyHostileFar = false
      for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !isAliveEntity(e)) continue
        if (!mobEntityMatchesQuery(e, queryEn)) continue
        anyName = true
        if (partyIFF.getEffectiveIFF(e) === IFF.HOSTILE) {
          const d = bot.entity.position.distanceTo(e.position)
          if (Number.isFinite(d) && d > maxDist) anyHostileFar = true
        }
      }
      if (!anyName) return { ok: false, code: 'target_not_found', retryable: false }
      if (anyHostileFar) return { ok: false, code: 'target_not_visible', retryable: false }
      return { ok: false, code: 'target_not_visible', retryable: false }
    }
    if (!rows.length) {
      let anyHostileAlive = false
      for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !isAliveEntity(e)) continue
        if (partyIFF.getEffectiveIFF(e) === IFF.HOSTILE) {
          anyHostileAlive = true
          break
        }
      }
      return { ok: false, code: anyHostileAlive ? 'target_not_visible' : 'target_not_found', retryable: false }
    }
    return pickWithAmbiguity(rows)
  }

  // typed mob / loose token
  const mobRaw = String(args.mobQuery || '').trim()
  const queryEn = normalizeMobQueryToken(mobRaw)
  if (!queryEn) return { ok: false, code: 'target_not_found', retryable: false }

  const nameMatches = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !isAliveEntity(e)) continue
    if (mobEntityMatchesQuery(e, queryEn)) nameMatches.push(e)
  }
  if (!nameMatches.length) return { ok: false, code: 'target_not_found', retryable: false }

  const visibleHostileMatching = []
  for (const e of nameMatches) {
    if (!passesV1Visible(bot, e, maxDist)) continue
    if (partyIFF.getEffectiveIFF(e) !== IFF.HOSTILE) continue
    visibleHostileMatching.push({ entity: e, d: bot.entity.position.distanceTo(e.position) })
  }

  if (visibleHostileMatching.length) {
    return pickWithAmbiguity(visibleHostileMatching)
  }

  for (const e of nameMatches) {
    if (partyIFF.getEffectiveIFF(e) !== IFF.HOSTILE) {
      return { ok: false, code: 'friendly_target', retryable: false }
    }
  }

  return { ok: false, code: 'target_not_visible', retryable: false }
}

module.exports = {
  resolveAttackTarget,
  entityAttackLabelRu,
  normalizeMobQueryToken,
  mobEntityMatchesQuery
}
