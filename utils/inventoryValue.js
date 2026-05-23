'use strict'

const FOOD_DENYLIST = new Set([
  'rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'chorus_fruit'
])

const HEALING_ITEM_NAMES = new Set([
  'golden_apple', 'enchanted_golden_apple', 'suspicious_stew', 'potion'
])

/**
 * Approximate loot value per item type (per unit). Higher = more valuable.
 * Used for normalized `inventoryValueScore` (0..1).
 */
const ITEM_VALUES = {
  oak_log: 1, birch_log: 1, spruce_log: 1, jungle_log: 1,
  acacia_log: 1, dark_oak_log: 1, mangrove_log: 1, cherry_log: 1,
  coal: 2, charcoal: 2,
  iron_ore: 3, raw_iron: 3, iron_ingot: 6,
  gold_ore: 5, raw_gold: 5, gold_ingot: 10,
  lapis_lazuli: 4,
  redstone: 2,
  diamond: 20, diamond_ore: 18,
  emerald: 18, emerald_ore: 16,
  ancient_debris: 25, netherite_scrap: 30, netherite_ingot: 40,
  ender_pearl: 8, blaze_rod: 6, ghast_tear: 12, wither_skull: 30,
  golden_apple: 25, enchanted_golden_apple: 50
}

/** Total slots in a player inventory. */
const INVENTORY_SLOTS = 36

/** Denominator for `getInventoryValueScore` normalization (tune as needed). */
const VALUE_SCORE_DENOMINATOR = 200

/**
 * Fraction of inventory slots currently occupied (0..1).
 * @param {import('mineflayer').Bot} bot
 * @returns {number}
 */
function getInventoryFillRatio (bot) {
  try {
    const items = bot.inventory?.items?.() || []
    return Math.min(1, items.length / INVENTORY_SLOTS)
  } catch (_) {
    return 0
  }
}

/**
 * Normalized loot value in inventory (0..1, capped at 1).
 * @param {import('mineflayer').Bot} bot
 * @returns {number}
 */
function getInventoryValueScore (bot) {
  try {
    const items = bot.inventory?.items?.() || []
    let total = 0
    for (const item of items) {
      const v = ITEM_VALUES[item?.name]
      if (v) total += v * (Number(item.count) || 1)
    }
    return Math.min(1, total / VALUE_SCORE_DENOMINATOR)
  } catch (_) {
    return 0
  }
}

/**
 * Number of free inventory slots.
 * @param {import('mineflayer').Bot} bot
 * @returns {number}
 */
function getFreeSlots (bot) {
  try {
    const items = bot.inventory?.items?.() || []
    return Math.max(0, INVENTORY_SLOTS - items.length)
  } catch (_) {
    return INVENTORY_SLOTS
  }
}

/**
 * Whether the bot has at least one edible (non-harmful) food item.
 * @param {import('mineflayer').Bot} bot
 * @returns {boolean}
 */
function hasAnyFood (bot) {
  try {
    const byName = bot.registry?.foodsByName
    if (!byName) return false
    for (const item of bot.inventory?.items?.() || []) {
      if (!item?.name || FOOD_DENYLIST.has(item.name)) continue
      if (byName[item.name]) return true
    }
    return false
  } catch (_) {
    return false
  }
}

/**
 * Whether the bot has any healing item (golden apple, potion, etc.).
 * @param {import('mineflayer').Bot} bot
 * @returns {boolean}
 */
function hasHealing (bot) {
  try {
    for (const item of bot.inventory?.items?.() || []) {
      if (!item?.name) continue
      if (HEALING_ITEM_NAMES.has(item.name)) return true
    }
    return false
  } catch (_) {
    return false
  }
}

module.exports = {
  ITEM_VALUES,
  INVENTORY_SLOTS,
  getInventoryFillRatio,
  getInventoryValueScore,
  getFreeSlots,
  hasAnyFood,
  hasHealing
}
