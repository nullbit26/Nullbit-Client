'use strict'

const { sleep } = require('../combat/session/constants')

/** @param {import('prismarine-item').Item} item */
function isKeepableDumpItem (item) {
  if (!item || !item.name) return false
  const n = String(item.name).toLowerCase()
  if (n.includes('potion')) return true
  if (n === 'shield' || n.includes('totem')) return true
  if (n === 'elytra' || n === 'turtle_shell') return true
  if (n.includes('_helmet') || n.includes('_chestplate') || n.includes('_leggings') || n.includes('_boots')) return true
  if (n.endsWith('_sword') || n === 'mace' || n === 'bow' || n === 'crossbow' || n === 'trident') return true
  if (n.endsWith('_axe')) return true
  if (n.includes('arrow')) return true
  if (n === 'milk_bucket') return true

  const FOOD_KEEP = new Set([
    'apple',
    'golden_apple',
    'enchanted_golden_apple',
    'bread',
    'cookie',
    'melon_slice',
    'carrot',
    'golden_carrot',
    'potato',
    'baked_potato',
    'beetroot',
    'beetroot_soup',
    'mushroom_stew',
    'rabbit_stew',
    'suspicious_stew',
    'dried_kelp',
    'sweet_berries',
    'glow_berries',
    'honey_bottle',
    'pumpkin_pie',
    'chorus_fruit',
    'beef',
    'porkchop',
    'mutton',
    'chicken',
    'rabbit',
    'cod',
    'salmon',
    'cooked_beef',
    'cooked_porkchop',
    'cooked_mutton',
    'cooked_chicken',
    'cooked_rabbit',
    'cooked_cod',
    'cooked_salmon',
    'raw_beef',
    'raw_porkchop',
    'raw_mutton',
    'raw_chicken',
    'raw_rabbit',
    'raw_cod',
    'raw_salmon'
  ])
  if (FOOD_KEEP.has(n)) return true
  if (n === 'rotten_flesh' || n === 'poisonous_potato' || n === 'pufferfish') return false
  return false
}

/**
 * @param {import('mineflayer').Bot} bot
 * @returns {string}
 */
function buildInventorySummary (bot) {
  const items = bot.inventory.items()
  if (!items.length) {
    return 'Inventory is empty / Инвентарь пуст.'
  }

  const main = bot.heldItem
  const offSlot = bot.supportFeature?.('doesntHaveOffHandSlot') ? null : bot.inventory?.slots?.[45]
  const mainStr = main ? `${main.name}×${main.count}` : 'empty'
  const offStr = offSlot ? `${offSlot.name}×${offSlot.count}` : 'empty'

  const totals = new Map()
  for (const it of items) {
    if (!it?.name) continue
    totals.set(it.name, (totals.get(it.name) || 0) + it.count)
  }
  const parts = []
  for (const [name, count] of [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push(`${name}(${count})`)
  }
  const invBody = parts.length ? parts.join(', ') : '—'
  return `[Hands] Main: ${mainStr} | Off: ${offStr}. [Inv]: ${invBody}`
}

/**
 * @param {import('mineflayer').Bot} bot
 */
async function dumpUnwantedItems (bot) {
  for (let guard = 0; guard < 256; guard++) {
    const items = bot.inventory.items().filter((it) => it && !isKeepableDumpItem(it))
    if (!items.length) break
    const it = items[0]
    try {
      if (typeof bot.tossStack === 'function') await bot.tossStack(it)
      else await bot.toss(it.type, null, it.count)
    } catch (e) {
      console.warn('[inv dump] toss:', it?.name, e?.message || e)
      break
    }
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(5)
    else await sleep(250)
  }
}

/** @param {string} s */
function normQuery (s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

/** @type {Record<string, string[]>} */
const RU_ITEM_ALIASES = {
  камень: ['stone', 'cobblestone'],
  булыжник: ['cobblestone'],
  земля: ['dirt'],
  доски: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks'],
  палка: ['stick'],
  факел: ['torch'],
  уголь: ['coal', 'charcoal'],
  железо: ['iron_ingot', 'raw_iron'],
  'железный слиток': ['iron_ingot'],
  золото: ['gold_ingot', 'raw_gold'],
  алмаз: ['diamond'],
  изумруд: ['emerald'],
  хлеб: ['bread'],
  яблоко: ['apple', 'golden_apple', 'enchanted_golden_apple'],
  морковь: ['carrot', 'golden_carrot'],
  картошка: ['potato', 'baked_potato'],
  стрела: ['arrow', 'spectral_arrow', 'tipped_arrow'],
  меч: ['wooden_sword', 'stone_sword', 'iron_sword', 'golden_sword', 'diamond_sword', 'netherite_sword'],
  топор: ['wooden_axe', 'stone_axe', 'iron_axe', 'golden_axe', 'diamond_axe', 'netherite_axe'],
  лук: ['bow'],
  арбалет: ['crossbow'],
  щит: ['shield']
}

/**
 * @param {import('prismarine-item').Item[]} items
 * @param {string} rawQuery
 * @returns {string | null} inventory item.name (canonical)
 */
function resolveInventoryItemName (items, rawQuery) {
  const q = normQuery(rawQuery)
  if (!q) return null

  const all = items.filter((it) => it && it.name)
  if (!all.length) return null

  const nameSet = new Set(all.map((it) => it.name))
  const queryId = q.replace(/\s+/g, '_')
  if (nameSet.has(queryId)) return queryId

  const aliasNames = RU_ITEM_ALIASES[q] || []
  for (const n of aliasNames) {
    if (nameSet.has(n)) return n
  }

  /** @type {Map<string, number>} */
  const scores = new Map()
  for (const it of all) {
    const n = String(it.name || '')
    const nameHuman = normQuery(n.replace(/_/g, ' '))
    const disp = normQuery(it.displayName || '')
    let sc = 0
    if (nameHuman === q || disp === q) sc += 100
    if (nameHuman.includes(q) || disp.includes(q)) sc += 30
    if (q.includes(nameHuman) || (disp && q.includes(disp))) sc += 10
    if (sc > 0) scores.set(n, (scores.get(n) || 0) + sc)
  }
  if (!scores.size) return null
  let best = null
  let bestSc = -1
  for (const [n, sc] of scores.entries()) {
    if (sc > bestSc) {
      bestSc = sc
      best = n
    }
  }
  return best
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {number} quantity
 * @param {string} itemQuery
 * @returns {Promise<{ ok: boolean, dropped: number, itemName?: string, reason?: string }>}
 */
async function tossItemByQuery (bot, quantity, itemQuery) {
  const want = Math.max(1, Math.floor(Number(quantity) || 0))
  const items = bot.inventory.items()
  const itemName = resolveInventoryItemName(items, itemQuery)
  if (!itemName) return { ok: false, dropped: 0, reason: 'not_found' }

  let remaining = want
  let dropped = 0
  const stacks = bot.inventory.items().filter((it) => it?.name === itemName)
  for (const it of stacks) {
    if (remaining <= 0) break
    const cnt = Math.min(remaining, Number(it.count) || 0)
    if (cnt <= 0) continue
    try {
      await bot.toss(it.type, null, cnt)
      dropped += cnt
      remaining -= cnt
    } catch (e) {
      console.warn('[inv drop by query] toss:', it?.name, e?.message || e)
      break
    }
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(4)
    else await sleep(200)
  }
  return { ok: dropped > 0, dropped, itemName, reason: dropped > 0 ? undefined : 'not_enough_or_failed' }
}

module.exports = {
  buildInventorySummary,
  dumpUnwantedItems,
  isKeepableDumpItem,
  tossItemByQuery
}
