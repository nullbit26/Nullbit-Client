'use strict'

const { ITEM_VALUES } = require('./inventoryValue')

/**
 * Items considered junk — safe to drop during expeditions.
 * Sorted roughly by priority to drop first (least valuable first).
 */
const JUNK_ITEMS = new Set([
  // Stone / building blocks
  'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate',
  'andesite', 'diorite', 'granite', 'tuff', 'calcite',
  'dirt', 'coarse_dirt', 'rooted_dirt', 'gravel', 'sand', 'red_sand',
  'netherrack', 'soul_sand', 'soul_soil',
  // Low-value flora
  'grass', 'fern', 'dead_bush', 'vine', 'seagrass', 'tall_seagrass',
  // Misc drops that accumulate
  'flint', 'stick',
  // Rotten food
  'rotten_flesh',
])

/**
 * Items that must NEVER be dropped regardless of fill ratio.
 * Tools, weapons, armor, food, torches, valuable ore, crafting materials.
 */
const KEEP_ALWAYS = new Set([
  // Tools & weapons
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe',
  'diamond_pickaxe', 'netherite_pickaxe',
  'wooden_axe', 'stone_axe', 'iron_axe', 'golden_axe',
  'diamond_axe', 'netherite_axe',
  'wooden_sword', 'stone_sword', 'iron_sword', 'golden_sword',
  'diamond_sword', 'netherite_sword',
  'wooden_shovel', 'stone_shovel', 'iron_shovel', 'golden_shovel',
  'diamond_shovel', 'netherite_shovel',
  // Armor
  'leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots',
  'chainmail_helmet', 'chainmail_chestplate', 'chainmail_leggings', 'chainmail_boots',
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots',
  'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
  'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots',
  'turtle_helmet',
  // Valuable ores & ingots
  'coal', 'charcoal',
  'raw_iron', 'iron_ingot', 'iron_ore', 'deepslate_iron_ore',
  'raw_gold', 'gold_ingot', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore',
  'raw_copper', 'copper_ingot', 'copper_ore', 'deepslate_copper_ore',
  'diamond', 'diamond_ore', 'deepslate_diamond_ore',
  'emerald', 'emerald_ore', 'deepslate_emerald_ore',
  'lapis_lazuli', 'lapis_ore', 'deepslate_lapis_ore',
  'redstone', 'redstone_ore', 'deepslate_redstone_ore',
  'ancient_debris', 'netherite_scrap', 'netherite_ingot',
  // Food
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'baked_potato',
  'apple', 'golden_apple', 'enchanted_golden_apple',
  'carrot', 'golden_carrot', 'melon_slice', 'pumpkin_pie',
  'mushroom_stew', 'rabbit_stew', 'suspicious_stew',
  // Utility
  'torch', 'crafting_table', 'chest', 'furnace',
  'bucket', 'water_bucket', 'lava_bucket',
  'ladder', 'rope',
  // Healing
  'potion', 'splash_potion', 'lingering_potion',
])

/**
 * Check whether an item is safe to drop.
 * Logic: junk denylist OR (not in KEEP_ALWAYS AND value = 0).
 *
 * @param {object} item — mineflayer item object
 * @returns {boolean}
 */
function isJunk (item) {
  if (!item?.name) return false
  if (KEEP_ALWAYS.has(item.name)) return false
  if (JUNK_ITEMS.has(item.name)) return true
  // Any item not in KEEP_ALWAYS and with no assigned value is also droppable
  // when inventory is critically full
  return !(item.name in ITEM_VALUES)
}

/**
 * Drop junk items from the bot's inventory to free up slots.
 * Drops cheapest items first (JUNK_ITEMS before low-value unknowns).
 * Stops as soon as `targetFreeSlots` are available.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} [opts]
 * @param {number} [opts.targetFreeSlots=6]   — stop dropping when this many slots are free
 * @param {number} [opts.maxDrops=16]          — safety cap: never drop more than this many stacks
 * @param {any}    [opts.logger]               — optional logger
 * @returns {Promise<number>} count of item stacks dropped
 */
async function dropJunk (bot, opts = {}) {
  const targetFree = Math.max(1, Math.floor(Number(opts.targetFreeSlots) || 6))
  const maxDrops   = Math.max(1, Math.floor(Number(opts.maxDrops) || 16))
  const log = opts.logger || null

  const INVENTORY_SLOTS = 36
  let dropped = 0

  try {
    // Build candidate list: all junk items sorted — explicit JUNK_ITEMS first,
    // then zero-value unknowns — within each group sort by count ascending
    // (drop smallest stacks first to minimise loss if interrupted)
    const items = bot.inventory?.items?.() || []
    const candidates = items
      .filter(item => isJunk(item))
      .sort((a, b) => {
        const aIsJunk = JUNK_ITEMS.has(a.name) ? 0 : 1
        const bIsJunk = JUNK_ITEMS.has(b.name) ? 0 : 1
        if (aIsJunk !== bIsJunk) return aIsJunk - bIsJunk
        return (a.count || 0) - (b.count || 0)
      })

    for (const item of candidates) {
      if (dropped >= maxDrops) break

      // Re-check free slots on each iteration (drops may have been picked up back)
      const currentItems = bot.inventory?.items?.() || []
      const freeNow = Math.max(0, INVENTORY_SLOTS - currentItems.length)
      if (freeNow >= targetFree) break

      try {
        await bot.toss(item.type, null, item.count)
        dropped++
        try { log?.info?.(`[InventoryManager] dropped ${item.count}x ${item.name}`) } catch (_) {}
      } catch (_) {
        // Slot may have changed — skip silently
      }
    }
  } catch (_) {}

  return dropped
}

/**
 * Returns true if the inventory is critically full and junk dropping should run.
 * @param {import('mineflayer').Bot} bot
 * @param {number} [threshold=0.85] — fill ratio above which to trigger
 * @returns {boolean}
 */
function shouldDropJunk (bot, threshold = 0.85) {
  try {
    const items = bot.inventory?.items?.() || []
    const ratio = items.length / 36
    return ratio >= threshold
  } catch (_) {
    return false
  }
}

module.exports = { isJunk, dropJunk, shouldDropJunk, JUNK_ITEMS, KEEP_ALWAYS }
