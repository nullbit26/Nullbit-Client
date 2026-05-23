'use strict'

/**
 * AutoGearSystem — automatically equips best armor on spawn/respawn.
 *
 * Armor tiers per slot (best → worst):
 *   head:  netherite → diamond → iron → chainmail → golden → leather
 *   chest: same order
 *   legs:  same order
 *   feet:  same order
 */

const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']

const ARMOR_SLOTS = [
  { slot: 'head',  suffixes: ['_helmet'] },
  { slot: 'torso', suffixes: ['_chestplate'] },
  { slot: 'legs',  suffixes: ['_leggings'] },
  { slot: 'feet',  suffixes: ['_boots'] },
]

/**
 * Find the best armor piece for a given slot from inventory.
 * @param {import('mineflayer').Bot} bot
 * @param {string[]} suffixes
 * @returns {import('prismarine-item').Item | null}
 */
function findBestArmor(bot, suffixes) {
  if (!bot?.inventory?.items) return null
  const items = bot.inventory.items()
  let best = null
  let bestTier = ARMOR_TIERS.length

  for (const item of items) {
    for (const suffix of suffixes) {
      const tierIdx = ARMOR_TIERS.findIndex(t => item.name === t + suffix)
      if (tierIdx !== -1 && tierIdx < bestTier) {
        bestTier = tierIdx
        best = item
      }
    }
  }
  return best
}

/**
 * Get currently equipped armor item for a slot.
 * @param {import('mineflayer').Bot} bot
 * @param {string} slot
 * @returns {import('prismarine-item').Item | null}
 */
function getEquippedArmor(bot, slot) {
  try {
    return bot.inventory.slots[bot.getEquipmentDestSlot(slot)] || null
  } catch (_) {
    return null
  }
}

class AutoGearSystem {
  /**
   * @param {{ bot: import('mineflayer').Bot, brain: any }} ctx
   */
  constructor({ bot, brain }) {
    this._bot = bot
    this._brain = brain
    this._wired = false
    this._busy = false
    this._onSpawn = this._onSpawn.bind(this)
  }

  init() {
    if (this._wired) return
    this._wired = true
    this._bot.on('spawn', this._onSpawn)
    // Equip immediately on init
    this._equipAllArmor().catch(() => {})
  }

  destroy() {
    if (!this._wired) return
    this._wired = false
    this._bot.off('spawn', this._onSpawn)
  }

  /** @private */
  _onSpawn() {
    // Small delay after respawn so inventory is loaded
    setTimeout(() => {
      this._equipAllArmor().catch(() => {})
    }, 1200)
  }

  /** @private */
  async _equipAllArmor() {
    if (this._busy) return
    this._busy = true
    try {
      for (const { slot, suffixes } of ARMOR_SLOTS) {
        const equipped = getEquippedArmor(this._bot, slot)
        const best = findBestArmor(this._bot, suffixes)
        if (!best) continue

        // Already wearing best — check if current is worse
        if (equipped) {
          const equippedTier = ARMOR_TIERS.findIndex(t =>
            suffixes.some(s => equipped.name === t + s)
          )
          const bestTier = ARMOR_TIERS.findIndex(t =>
            suffixes.some(s => best.name === t + s)
          )
          if (equippedTier !== -1 && equippedTier <= bestTier) continue
        }

        try {
          await this._bot.equip(best, slot)
          try {
            this._brain.log.info(`[AutoGear] Equipped ${best.name} → ${slot}`)
          } catch (_) {}
        } catch (e) {
          try {
            this._brain.log.warn(`[AutoGear] Failed to equip ${best.name}: ${e.message}`)
          } catch (_) {}
        }
      }
    } finally {
      this._busy = false
    }
  }
}

module.exports = { AutoGearSystem }
