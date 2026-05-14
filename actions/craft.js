const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

module.exports = function createCraftActions(bot, deps) {
  const { utils, getMcData } = deps
  const { log } = utils

  function safeChat(text) {
    const maxLen = 240
    const msg = String(text || '').slice(0, maxLen)
    if (msg) bot.chat(msg)
  }

  async function craftGear() {
    const mcData = getMcData()
    if (!mcData) return safeChat('Not ready yet.')

    const iron = bot.inventory.items().filter((i) => i.name === 'iron_ingot')
    const ironCount = iron.reduce((s, i) => s + i.count, 0)
    if (ironCount < 5) {
      safeChat(`Not enough iron. Have ${ironCount}, need at least 5.`)
      return
    }

    let craftingTable = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 })
    if (!craftingTable) {
      const tableItem = bot.inventory.items().find((i) => i.name === 'crafting_table')
      if (tableItem) {
        const refBlock = bot.blockAt(bot.entity.position.offset(1, -1, 0))
        if (refBlock) {
          await bot.equip(tableItem, 'hand')
          await bot.placeBlock(refBlock, new Vec3(0, 1, 0))
          await bot.waitForTicks(5)
          craftingTable = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 5 })
        }
      }
    }

    if (!craftingTable) {
      safeChat('No crafting table nearby and none in inventory!')
      return
    }

    const p = craftingTable.position
    await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2))

    const wantedGear = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword']
    const crafted = []
    const skipped = []

    for (const itemName of wantedGear) {
      const alreadyHave = bot.inventory.items().some((i) => i.name === itemName)
      const equipped = Object.values(bot.inventory.slots).some((s) => s?.name === itemName)
      if (alreadyHave || equipped) {
        skipped.push(itemName)
        continue
      }
      const itemDef = mcData.itemsByName[itemName]
      if (!itemDef) {
        skipped.push(`${itemName}(missing data)`)
        continue
      }
      const recipe = bot.recipesFor(itemDef.id, null, 1, craftingTable)[0]
      if (!recipe) {
        skipped.push(`${itemName}(no recipe)`)
        continue
      }
      try {
        await bot.craft(recipe, 1, craftingTable)
        crafted.push(itemName)
        await bot.waitForTicks(2)
      } catch (e) {
        log(`[craft] failed ${itemName}: ${e.message}`)
        skipped.push(`${itemName}(no materials)`)
      }
    }

    const armorSlots = {
      iron_helmet: 'head',
      iron_chestplate: 'torso',
      iron_leggings: 'legs',
      iron_boots: 'feet'
    }
    for (const [itemName, slot] of Object.entries(armorSlots)) {
      const item = bot.inventory.items().find((i) => i.name === itemName)
      if (!item) continue
      try {
        await bot.equip(item, slot)
      } catch (e) {
        log(`[craft] equip ${itemName} failed: ${e.message}`)
      }
    }

    const msg = crafted.length > 0
      ? `Crafted: ${crafted.join(', ')}` + (skipped.length ? ` | Skipped: ${skipped.join(', ')}` : '')
      : `Nothing to craft. Skipped: ${skipped.join(', ')}`
    safeChat(msg)
  }

  return {
    craftGear
  }
}
