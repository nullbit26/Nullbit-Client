'use strict'

/** Имена мобов (entity.name), считаем враждебными для сводки. */
const HOSTILE_MOB = new Set([
  'zombie',
  'zombie_villager',
  'husk',
  'drowned',
  'zombie_horse',
  'skeleton',
  'stray',
  'bogged',
  'wither_skeleton',
  'skeleton_horse',
  'creeper',
  'spider',
  'cave_spider',
  'enderman',
  'witch',
  'phantom',
  'slime',
  'magma_cube',
  'blaze',
  'ghast',
  'piglin',
  'piglin_brute',
  'hoglin',
  'zoglin',
  'pillager',
  'vindicator',
  'evoker',
  'vex',
  'ravager',
  'silverfish',
  'endermite',
  'guardian',
  'elder_guardian',
  'shulker',
  'warden',
  'illusioner'
])

const PASSIVE_MOB = new Set([
  'cow',
  'pig',
  'sheep',
  'chicken',
  'rabbit',
  'fox',
  'panda',
  'parrot',
  'turtle',
  'cod',
  'salmon',
  'tropical_fish',
  'pufferfish',
  'squid',
  'glow_squid',
  'axolotl',
  'frog',
  'tadpole',
  'villager',
  'wandering_trader',
  'iron_golem',
  'snow_golem',
  'bat',
  'mooshroom',
  'horse',
  'donkey',
  'mule',
  'llama',
  'trader_llama',
  'camel',
  'sniffer',
  'ocelot',
  'allay',
  'bee',
  'wolf'
])

function itemShort (bot, item) {
  if (!item || !item.name) return 'пусто'
  const meta = bot.registry?.itemsByName?.[item.name]
  const dn = meta?.displayName
  if (dn && String(dn).trim()) return String(dn).trim()
  return item.name.replace(/_/g, ' ')
}

function isValuableOre (name) {
  if (!name || typeof name !== 'string') return false
  return (
    name.includes('diamond_ore') ||
    name.includes('emerald_ore') ||
    name.includes('ancient_debris') ||
    name.includes('gold_ore') ||
    name.includes('deepslate_gold_ore') ||
    name.includes('lapis_ore') ||
    name.includes('deepslate_lapis_ore') ||
    name.includes('redstone_ore') ||
    name.includes('deepslate_redstone_ore')
  )
}

/** Алмазы / изумруды / золото (для «лут»-триггеров). */
function isPremiumOreBlock (name) {
  if (!name || typeof name !== 'string') return false
  return (
    name.includes('diamond_ore') ||
    name.includes('emerald_ore') ||
    name.includes('gold_ore') ||
    name.includes('deepslate_gold_ore') ||
    name.includes('nether_gold_ore')
  )
}

function isTrashHeldItem (name) {
  if (!name) return false
  const n = name.toLowerCase()
  return (
    n.includes('dirt') ||
    n.includes('coarse_dirt') ||
    n.includes('stick') ||
    n.includes('cobblestone') ||
    n.includes('netherrack') ||
    n.includes('rotten_flesh') ||
    n.includes('string')
  )
}

function nearestBlockLine (bot, point, labelRu, matcher, maxDist, requireVisible) {
  try {
    const pts = bot.findBlocks({
      point,
      maxDistance: maxDist,
      count: 6,
      matching: matcher
    })
    if (!pts.length) return null
    for (let i = 0; i < pts.length; i++) {
      const b = bot.blockAt(pts[i])
      if (!b) continue
      const d = Math.round(point.distanceTo(pts[i]))
      if (requireVisible && typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(b)) continue
      return `${labelRu} в ${d}м (${b.name})`
    }
  } catch (_) {}
  return null
}

/**
 * Структурированный снимок ~32м — для сравнения и автономной логики.
 */
function scanEnvironment (bot, radius = 32) {
  if (!bot.entity || !bot.entity.position) {
    return { ok: false, reason: 'no_entity' }
  }

  const R = radius
  const pos = bot.entity.position

  const players = []
  for (const username of Object.keys(bot.players || {})) {
    if (username === bot.username) continue
    const p = bot.players[username]
    const ent = p?.entity
    if (!ent || !ent.position) continue
    const d = pos.distanceTo(ent.position)
    if (d > R) continue
    const heldName = ent.heldItem?.name || ''
    players.push({
      username,
      dist: d,
      distRounded: Math.round(d),
      hp: ent.health != null ? Math.round(ent.health) : null,
      handLabel: itemShort(bot, ent.heldItem),
      heldName,
      trashHand: isTrashHeldItem(heldName)
    })
  }

  let hostileMinDist = null
  let hostileNearestName = null
  let creeperMinDist = null

  const hostileByName = new Map()
  const passiveByName = new Map()
  const otherByName = new Map()

  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity) continue
    if (!e.position) continue
    if (e.name === 'item' || e.name === 'arrow' || e.name === 'experience_orb') continue
    if (e.type === 'player') continue
    const d = pos.distanceTo(e.position)
    if (d > R) continue
    const n = (e.name || '').toLowerCase()
    if (!n) continue

    if (HOSTILE_MOB.has(n)) {
      if (hostileMinDist == null || d < hostileMinDist) {
        hostileMinDist = d
        hostileNearestName = n
      }
      if (n === 'creeper') {
        if (creeperMinDist == null || d < creeperMinDist) creeperMinDist = d
      }
    }

    const bucket = HOSTILE_MOB.has(n) ? hostileByName : PASSIVE_MOB.has(n) ? passiveByName : otherByName
    if (!bucket.has(n)) bucket.set(n, { count: 0, minD: Infinity })
    const rec = bucket.get(n)
    rec.count += 1
    rec.minD = Math.min(rec.minD, d)
  }

  let premiumOreVisible = false
  let premiumOreName = null
  let premiumOreDist = null
  try {
    const pts = bot.findBlocks({
      point: pos.floored ? pos.floored() : pos,
      maxDistance: R,
      count: 12,
      matching: (b) => b && isPremiumOreBlock(b.name)
    })
    for (let i = 0; i < pts.length; i++) {
      const b = bot.blockAt(pts[i])
      if (!b) continue
      if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(b)) continue
      const dist = pos.distanceTo(pts[i])
      premiumOreVisible = true
      premiumOreName = b.name
      premiumOreDist = Math.round(dist)
      break
    }
  } catch (_) {}

  const hp = bot.health != null ? Math.round(bot.health) : null
  const food = bot.food != null ? Math.round(bot.food) : null

  return {
    ok: true,
    pos: { x: pos.x, y: pos.y, z: pos.z },
    health: hp,
    food,
    players,
    hostileMinDist,
    hostileNearestName,
    creeperMinDist,
    hostileByName,
    passiveByName,
    otherByName,
    premiumOreVisible,
    premiumOreName,
    premiumOreDist
  }
}

function formatMobGroup (map, label) {
  if (!map.size) return null
  const lines = []
  for (const [name, { count, minD }] of map) {
    const ru = name.replace(/_/g, ' ')
    const cnt = count > 1 ? `${count}×` : ''
    lines.push(`${cnt}${ru} (~${Math.round(minD)}м)`)
  }
  return `${label}: ${lines.join(', ')}.`
}

/**
 * Компактная строка для OpenAI Assistant (tool getEnvironment).
 */
function getEnvironment (bot) {
  const snap = scanEnvironment(bot)
  if (!snap.ok) {
    return 'Бот ещё не в мире (нет позиции).'
  }

  const R = 32
  const pos = bot.entity.position
  const parts = []

  parts.push(
    `Я на ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)} | HP ${snap.health ?? '?'}/20 | голод ${snap.food ?? '?'}/20`
  )

  if (snap.players.length) {
    const playerBits = snap.players.map(
      (p) => `[${p.username}] в ${p.distRounded}м (HP: ${p.hp ?? '?'}, в руке: ${p.handLabel})`
    )
    parts.push(`Игроки: ${playerBits.join('; ')}.`)
  } else {
    parts.push('Игроков рядом нет.')
  }

  const hLine = formatMobGroup(snap.hostileByName, 'Враждебные')
  const pLine = formatMobGroup(snap.passiveByName, 'Мирные')
  const oLine = formatMobGroup(snap.otherByName, 'Прочие мобы')
  if (hLine) parts.push(hLine)
  if (pLine) parts.push(pLine)
  if (oLine) parts.push(oLine)
  if (!hLine && !pLine && !oLine) parts.push('Мобов в радиусе не видно.')

  const chestLine = nearestBlockLine(
    bot,
    pos,
    'Сундук/бочка',
    (b) => b && (b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel'),
    R,
    false
  )
  const tableLine = nearestBlockLine(
    bot,
    pos,
    'Верстак',
    (b) => b && b.name === 'crafting_table',
    R,
    false
  )
  const furnaceLine = nearestBlockLine(
    bot,
    pos,
    'Печь/курилка/доменная',
    (b) =>
      b &&
      (b.name === 'furnace' || b.name === 'blast_furnace' || b.name === 'smoker'),
    R,
    false
  )
  const bedLine = nearestBlockLine(
    bot,
    pos,
    'Кровать',
    (b) => b && typeof b.name === 'string' && b.name.includes('_bed') && b.name !== 'bedrock',
    R,
    false
  )
  const oreLine = nearestBlockLine(
    bot,
    pos,
    'Ценная руда (в поле зрения)',
    (b) => b && isValuableOre(b.name),
    R,
    true
  )

  const structBits = [chestLine, tableLine, furnaceLine, bedLine, oreLine].filter(Boolean)
  if (structBits.length) {
    parts.push(structBits.join(' '))
  } else {
    parts.push('Ближайших сундуков/верстаков/печей/кроватей в 32м не нашёл; ценной руды на виду нет.')
  }

  return parts.join(' ')
}

getEnvironment.scanEnvironment = scanEnvironment
getEnvironment.HOSTILE_MOB = HOSTILE_MOB
getEnvironment.isTrashHeldItem = isTrashHeldItem
getEnvironment.isPremiumOreBlock = isPremiumOreBlock
module.exports = getEnvironment
