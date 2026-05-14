'use strict'

const WEAPON_PRIORITY = [
  { key: 'netherite_sword', dmg: 8 },
  { key: 'diamond_sword', dmg: 7 },
  { key: 'iron_sword', dmg: 6 },
  { key: 'stone_sword', dmg: 5 },
  { key: 'golden_sword', dmg: 4 },
  { key: 'wooden_sword', dmg: 3 },
  { key: 'netherite_axe', dmg: 10 },
  { key: 'diamond_axe', dmg: 9 },
  { key: 'iron_axe', dmg: 7 },
  { key: 'stone_axe', dmg: 6 },
  { key: 'golden_axe', dmg: 5 },
  { key: 'wooden_axe', dmg: 4 }
]

function enchantCount (item) {
  return item?.nbt?.value?.Enchantments?.value?.value?.length ?? 0
}

function sortByEnchThenDurability (a, b) {
  const ae = enchantCount(a)
  const be = enchantCount(b)
  if (be !== ae) return be - ae
  return (a.durabilityUsed ?? 0) - (b.durabilityUsed ?? 0)
}

/** Лучший лук или арбалет из инвентаря. */
function pickBestBow (bot) {
  const items = bot.inventory.items().filter((i) => i.name === 'bow' || i.name === 'crossbow')
  if (!items.length) return null
  return items.sort(sortByEnchThenDurability)[0]
}

async function equipBestWeapon (bot, logTag = '[PVP]') {
  const items = bot.inventory.items()
  const ranked = WEAPON_PRIORITY.map((w, idx) => ({ ...w, idx }))
    .sort((a, b) => {
      if (b.dmg !== a.dmg) return b.dmg - a.dmg
      return a.idx - b.idx
    })

  let best = null
  for (const match of ranked) {
    const sameItems = items.filter((i) => i.name.toLowerCase().includes(match.key))
    if (!sameItems.length) continue

    const bestItem = sameItems.sort(sortByEnchThenDurability)[0]
    if (bestItem) {
      best = bestItem
      break
    }
  }
  if (best) {
    await bot.equip(best, 'hand')
    console.log(`${logTag} Оружие: ${best.name}`)
  }
  return best
}

async function equipShield (bot, logTag = '[PVP]') {
  const shields = bot.inventory.items().filter((i) => i.name.includes('shield'))
  if (!shields.length) return false
  const shield = shields.sort(sortByEnchThenDurability)[0]
  await bot.equip(shield, 'off-hand')
  console.log(`${logTag} Щит экипирован.`)
  return true
}

async function equipBestArmor (bot, logTag = '[PVP]') {
  const armorSlots = {
    head: ['netherite_helmet', 'diamond_helmet', 'iron_helmet', 'golden_helmet', 'chainmail_helmet', 'leather_helmet'],
    torso: [
      'netherite_chestplate',
      'diamond_chestplate',
      'iron_chestplate',
      'golden_chestplate',
      'chainmail_chestplate',
      'leather_chestplate'
    ],
    legs: ['netherite_leggings', 'diamond_leggings', 'iron_leggings', 'golden_leggings', 'chainmail_leggings', 'leather_leggings'],
    feet: ['netherite_boots', 'diamond_boots', 'iron_boots', 'golden_boots', 'chainmail_boots', 'leather_boots']
  }
  const slotIndex = { head: 5, torso: 6, legs: 7, feet: 8 }

  for (const [slot, priority] of Object.entries(armorSlots)) {
    const equipped = bot.inventory.slots[slotIndex[slot]]

    for (const armorName of priority) {
      if (equipped?.name === armorName) break

      const items = bot.inventory.items().filter((i) => i.name === armorName)
      if (!items.length) continue

      const item = items.sort(sortByEnchThenDurability)[0]
      if (item) {
        try {
          await bot.equip(item, slot)
          console.log(`${logTag} Броня: ${item.name} → ${slot}`)
        } catch (e) {
          console.log(`${logTag} Ошибка экипировки ${item.name}: ${e.message}`)
        }
        break
      }
    }
  }
}

module.exports = {
  WEAPON_PRIORITY,
  equipBestArmor,
  equipBestWeapon,
  equipShield,
  pickBestBow,
  enchantCount
}
