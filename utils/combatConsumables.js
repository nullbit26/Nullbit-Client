'use strict'

/**
 * @param {import('prismarine-item').Item} item
 * @returns {string}
 */
function potionNbtString (item) {
  if (!item?.nbt) return ''
  try {
    const nbt = item.nbt
    const pot =
      nbt?.value?.Potion?.value ??
      nbt?.value?.potion?.value ??
      nbt?.Potion ??
      (typeof nbt?.value === 'object' && nbt.value?.Potion) ??
      ''
    return String(pot).toLowerCase()
  } catch (_) {
    return ''
  }
}

/**
 * Healing / regeneration (and regen alias) from NBT — item.name is always `potion` / `splash_potion` / `lingering_potion`.
 * @param {import('prismarine-item').Item} item
 */
function potionLooksLikeHeal (item) {
  if (!item?.name) return false
  if (!['potion', 'splash_potion', 'lingering_potion'].includes(item.name)) return false
  let s = potionNbtString(item)
  if (!s) {
    try {
      s = String(item?.nbtData?.potion ?? item?.nbtData?.Potion ?? '').toLowerCase()
    } catch (_) {
      s = ''
    }
  }
  if (s) {
    return s.includes('healing') || s.includes('regeneration') || s.includes('regen')
  }
  // Minecraft 1.21+ (mineflayer can expose potions without readable NBT in inventory):
  // task guarantee says potion slots contain only heal/regeneration potions.
  return item.name === 'potion' || item.name === 'splash_potion' || item.name === 'lingering_potion'
}

/**
 * @param {import('prismarine-item').Item} item
 */
function isSplashLikePotion (item) {
  return item?.name === 'splash_potion' || item?.name === 'lingering_potion'
}

/**
 * @param {import('prismarine-item').Item} item
 * @param {number} hp
 * @param {number} hpThreshold
 */
function scoreHealPotion (item, hp, hpThreshold) {
  const s = potionNbtString(item)
  const instant = s.includes('healing')
  const regen = s.includes('regeneration') || s.includes('regen')
  const splash = isSplashLikePotion(item)
  let sc = 0
  if (instant) sc += hp < 8 ? 400 : hp < hpThreshold ? 280 : 90
  if (regen) sc += hp < hpThreshold ? 160 : 40
  if (!splash) sc += 30
  return sc
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {number} hpThreshold — e.g. flee-safe HP for prioritisation
 * @returns {import('prismarine-item').Item | null}
 */
function findBestHealPotion (bot, hpThreshold) {
  const items = bot.inventory.items().filter(potionLooksLikeHeal)
  if (!items.length) return null
  const hp = Number(bot.health)
  const h = Number.isFinite(hp) ? hp : 0
  const thr = Number.isFinite(Number(hpThreshold)) ? Number(hpThreshold) : 16
  let best = null
  let bestS = -1
  for (const it of items) {
    const sc = scoreHealPotion(it, h, thr)
    if (sc > bestS) {
      bestS = sc
      best = it
    }
  }
  return best
}

module.exports = {
  potionNbtString,
  potionLooksLikeHeal,
  isSplashLikePotion,
  findBestHealPotion
}
