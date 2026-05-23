'use strict'

/**
 * Axe names ordered from best to worst (index 0 = best).
 * Ranking: netherite → diamond → iron → stone → golden → wooden.
 * Golden axe mines fastest but has the worst durability and enchantability
 * in practice, so it is placed below stone in overall quality.
 */
const AXE_TIERS = [
  'netherite_axe',
  'diamond_axe',
  'iron_axe',
  'stone_axe',
  'golden_axe',
  'wooden_axe'
]

/**
 * Find the best axe in the bot's inventory without equipping it.
 * @param {import('mineflayer').Bot} bot
 * @returns {import('prismarine-item').Item | null}
 */
function findBestAxe (bot) {
  if (!bot?.inventory?.items) return null
  const items = bot.inventory.items()
  let best = null
  let bestTier = AXE_TIERS.length

  for (const item of items) {
    const tier = AXE_TIERS.indexOf(item.name)
    if (tier !== -1 && tier < bestTier) {
      bestTier = tier
      best = item
    }
  }
  return best
}

/**
 * Equip the best available axe to the main hand.
 * No-ops silently if no axe is found.
 * @param {import('mineflayer').Bot} bot
 * @returns {Promise<string|null>} item name that was equipped, or null
 */
async function equipBestAxe (bot) {
  const axe = findBestAxe(bot)
  if (!axe) return null
  // Skip equip if already holding the same item (by name + count slot)
  const held = bot.heldItem
  if (held && held.name === axe.name) return axe.name
  await bot.equip(axe, 'hand')
  return axe.name
}

/**
 * Pickaxe names ordered from best to worst (index 0 = best).
 */
const PICKAXE_TIERS = [
  'netherite_pickaxe',
  'diamond_pickaxe',
  'iron_pickaxe',
  'stone_pickaxe',
  'golden_pickaxe',
  'wooden_pickaxe'
]

/**
 * Find the best pickaxe in the bot's inventory without equipping it.
 * @param {import('mineflayer').Bot} bot
 * @returns {import('prismarine-item').Item | null}
 */
function findBestPickaxe (bot) {
  if (!bot?.inventory?.items) return null
  const items = bot.inventory.items()
  let best = null
  let bestTier = PICKAXE_TIERS.length
  for (const item of items) {
    const tier = PICKAXE_TIERS.indexOf(item.name)
    if (tier !== -1 && tier < bestTier) {
      bestTier = tier
      best = item
    }
  }
  return best
}

/**
 * Equip the best available pickaxe to the main hand.
 * No-ops silently if no pickaxe is found.
 * @param {import('mineflayer').Bot} bot
 * @returns {Promise<string|null>} item name that was equipped, or null
 */
async function equipBestPickaxe (bot) {
  const pick = findBestPickaxe(bot)
  if (!pick) return null
  const held = bot.heldItem
  if (held && held.name === pick.name) return pick.name
  await bot.equip(pick, 'hand')
  return pick.name
}

/**
 * Shovel names ordered from best to worst (index 0 = best).
 */
const SHOVEL_TIERS = [
  'netherite_shovel',
  'diamond_shovel',
  'iron_shovel',
  'stone_shovel',
  'golden_shovel',
  'wooden_shovel'
]

/**
 * Find the best shovel in the bot's inventory without equipping it.
 * @param {import('mineflayer').Bot} bot
 * @returns {import('prismarine-item').Item | null}
 */
function findBestShovel (bot) {
  if (!bot?.inventory?.items) return null
  const items = bot.inventory.items()
  let best = null
  let bestTier = SHOVEL_TIERS.length
  for (const item of items) {
    const tier = SHOVEL_TIERS.indexOf(item.name)
    if (tier !== -1 && tier < bestTier) {
      bestTier = tier
      best = item
    }
  }
  return best
}

/**
 * Equip the best available shovel to the main hand.
 * No-ops silently if no shovel is found.
 * @param {import('mineflayer').Bot} bot
 * @returns {Promise<string|null>} item name that was equipped, or null
 */
async function equipBestShovel (bot) {
  const shovel = findBestShovel(bot)
  if (!shovel) return null
  const held = bot.heldItem
  if (held && held.name === shovel.name) return shovel.name
  await bot.equip(shovel, 'hand')
  return shovel.name
}

module.exports = { AXE_TIERS, findBestAxe, equipBestAxe, PICKAXE_TIERS, findBestPickaxe, equipBestPickaxe, SHOVEL_TIERS, findBestShovel, equipBestShovel }
