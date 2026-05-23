'use strict'

const { sleep } = require('../utils/sleep')
const Vec3 = require('vec3')

const CHEST_INTERACT_TIMEOUT_MS = 10000
const TRANSFER_DELAY_MS = 100

/**
 * Storage System V1
 * MVP: Single double chest, dump everything except food/tools
 * No smart sorting - V2 feature
 */
class StorageSystem {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('./HomeBaseConfig')} homeBaseConfig
   * @param {import('./Brain')} brain
   */
  constructor (bot, homeBaseConfig, brain) {
    this._bot = bot
    this._config = homeBaseConfig
    this._brain = brain
    this._chestWindow = null
  }

  /**
   * Open chest at configured position
   * @returns {Promise<boolean>}
   * @private
   */
  async _openChest (pos = null) {
    const chestPos = pos || this._config.getChestPos()
    if (!chestPos) {
      this._log('ERROR: Chest position not configured')
      return false
    }

    const block = this._bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z))
    if (!block || !block.name.includes('chest')) {
      this._log(`ERROR: No chest at ${chestPos.x},${chestPos.y},${chestPos.z}`)
      return false
    }

    try {
      this._chestWindow = await this._bot.openContainer(block)
      await sleep(500)
      return true
    } catch (e) {
      this._log(`Failed to open chest at ${chestPos.x},${chestPos.y},${chestPos.z}: ${e.message}`)
      return false
    }
  }

  /**
   * Close chest window
   * @private
   */
  async _closeChest () {
    if (this._chestWindow) {
      try {
        await this._chestWindow.close()
        this._log('Chest closed')
      } catch (e) {
        // Ignore close errors
      }
      this._chestWindow = null
    }
  }

  /**
   * Deposit all items except essentials (food, pickaxe, axe, torch)
   * @returns {Promise<{deposited: number, items: string[]}>}
   */
  async depositAll () {
    const keepPatterns = [/pickaxe/, /axe/, /torch/, /bread/, /cooked/, /apple/]
    const depositedItems = []
    let depositedCount = 0
    const chestPositions = this._config.getChestPositions()

    for (const pos of chestPositions) {
      // Skip if inventory has nothing left to deposit
      const hasItems = this._bot.inventory.items().some(i => !keepPatterns.some(p => p.test(i.name)))
      if (!hasItems) break

      if (!(await this._openChest(pos))) continue

      try {
        const chestSize = this._chestWindow.inventoryStart
        const allSlots = this._chestWindow.slots

        const toDeposit = []
        for (let i = chestSize; i < allSlots.length; i++) {
          const item = allSlots[i]
          if (!item) continue
          if (keepPatterns.some(p => p.test(item.name))) continue
          toDeposit.push({ slot: i, item })
        }

        for (const { slot, item } of toDeposit) {
          try {
            let chestSlot = -1
            const maxStack = item.stackSize || 64
            for (let i = 0; i < chestSize; i++) {
              const cs = this._chestWindow.slots[i]
              if (cs && cs.type === item.type && cs.count < maxStack) { chestSlot = i; break }
            }
            if (chestSlot === -1) {
              for (let i = 0; i < chestSize; i++) {
                if (!this._chestWindow.slots[i]) { chestSlot = i; break }
              }
            }
            if (chestSlot === -1) { this._log(`Chest ${pos.x},${pos.y},${pos.z} full`); break }
            await this._bot.moveSlotItem(slot, chestSlot)
            depositedItems.push(`${item.name}x${item.count}`)
            depositedCount += item.count
            await sleep(TRANSFER_DELAY_MS)
          } catch (e) {
            this._log(`Failed to deposit ${item.name}: ${e.message}`)
          }
        }
      } catch (e) {
        this._log(`Deposit error at ${pos.x},${pos.y},${pos.z}: ${e.message}`)
      } finally {
        await this._closeChest()
      }
    }

    this._log(`Deposited ${depositedCount} items across ${chestPositions.length} chest(s): ${depositedItems.join(', ') || 'none'}`)
    return { deposited: depositedCount, items: depositedItems }
  }

  /**
   * Withdraw crafting materials for stone tools
   * @param {Object} needs - { planks: number, cobblestone: number, sticks: number }
   * @returns {Promise<{withdrawn: Object}>}
   */
  async withdrawCraftingMaterials (needs) {
    const withdrawn = {}
    const remaining = { ...needs }
    const chestPositions = this._config.getChestPositions()

    for (const pos of chestPositions) {
      const allDone = Object.values(remaining).every(v => v <= 0)
      if (allDone) break
      if (!(await this._openChest(pos))) continue

      try {
        const chestItems = this._chestWindow.containerItems()
        for (const [itemName, neededCount] of Object.entries(needs)) {
          if ((remaining[itemName] || 0) <= 0) continue
          for (const chestItem of chestItems) {
            if (remaining[itemName] <= 0) break
            if (!chestItem || !chestItem.name.includes(itemName)) continue
            const toTake = Math.min(remaining[itemName], chestItem.count)
            try {
              await this._chestWindow.withdraw(chestItem.type, null, toTake)
              withdrawn[itemName] = (withdrawn[itemName] || 0) + toTake
              remaining[itemName] -= toTake
              this._log(`Withdrew ${itemName} x${toTake} from ${pos.x},${pos.y},${pos.z}`)
              await sleep(TRANSFER_DELAY_MS)
            } catch (e) {
              this._log(`Failed to withdraw ${itemName}: ${e.message}`)
            }
          }
        }
      } catch (e) {
        this._log(`Withdraw error at ${pos.x},${pos.y},${pos.z}: ${e.message}`)
      } finally {
        await this._closeChest()
      }
    }

    for (const [itemName, neededCount] of Object.entries(needs)) {
      if ((remaining[itemName] || 0) > 0) {
        this._log(`WARNING: Not enough ${itemName} (needed ${neededCount}, got ${withdrawn[itemName] || 0})`)
      }
    }
    return { withdrawn }
  }

  /**
   * Withdraw any type of log from chests (oak_log, birch_log, etc.)
   * @param {number} count - how many logs to withdraw total
   * @returns {Promise<number>} actual amount withdrawn
   */
  async withdrawLogs (count) {
    let withdrawn = 0
    let remaining = count
    const chestPositions = this._config.getChestPositions()
    for (const pos of chestPositions) {
      if (remaining <= 0) break
      if (!(await this._openChest(pos))) continue
      try {
        const chestItems = this._chestWindow.containerItems()
        for (const item of chestItems) {
          if (remaining <= 0) break
          if (!item || !(item.name.endsWith('_log') || item.name === 'log')) continue
          const toTake = Math.min(remaining, item.count)
          try {
            await this._chestWindow.withdraw(item.type, null, toTake)
            withdrawn += toTake
            remaining -= toTake
            this._log(`Withdrew ${item.name} x${toTake} from ${pos.x},${pos.y},${pos.z}`)
            await sleep(TRANSFER_DELAY_MS)
          } catch (e) {
            this._log(`Failed to withdraw ${item.name}: ${e.message}`)
          }
        }
      } catch (e) {
        this._log(`withdrawLogs error at ${pos.x},${pos.y},${pos.z}: ${e.message}`)
      } finally {
        await this._closeChest()
      }
    }
    return withdrawn
  }

  /**
   * Withdraw a specific item from the chest by exact name.
   * @param {string} itemName - exact item name (e.g. 'torch', 'coal')
   * @param {number} count - how many to withdraw
   * @returns {Promise<number>} actual amount withdrawn
   */
  async withdrawItem (itemName, count) {
    let withdrawn = 0
    let remaining = count
    const chestPositions = this._config.getChestPositions()

    for (const pos of chestPositions) {
      if (remaining <= 0) break
      if (!(await this._openChest(pos))) continue

      try {
        const chestItems = this._chestWindow.containerItems()
        for (const item of chestItems) {
          if (remaining <= 0) break
          if (!item || item.name !== itemName) continue
          const toTake = Math.min(remaining, item.count)
          try {
            await this._chestWindow.withdraw(item.type, null, toTake)
            withdrawn += toTake
            remaining -= toTake
            this._log(`Withdrew ${itemName} x${toTake} from ${pos.x},${pos.y},${pos.z}`)
            await sleep(TRANSFER_DELAY_MS)
          } catch (e) {
            this._log(`Failed to withdraw ${itemName}: ${e.message}`)
          }
        }
      } catch (e) {
        this._log(`withdrawItem error at ${pos.x},${pos.y},${pos.z}: ${e.message}`)
      } finally {
        await this._closeChest()
      }
    }

    if (withdrawn < count) this._log(`withdrawItem: got ${withdrawn}/${count} ${itemName}`)
    return withdrawn
  }

  /**
   * Check if chest contains minimum resources for crafting
   * @returns {Promise<{hasResources: boolean, details: Object}>}
   */
  async checkResources () {
    if (!(await this._openChest())) {
      return { hasResources: false, details: {} }
    }

    const details = {}
    try {
      const chestItems = this._chestWindow.containerItems()

      // Count relevant items
      const counts = {}
      for (const item of chestItems) {
        if (!item) continue
        if (item.name.includes('plank')) counts.planks = (counts.planks || 0) + item.count
        if (item.name.includes('cobblestone')) counts.cobblestone = (counts.cobblestone || 0) + item.count
        if (item.name === 'stick') counts.sticks = (counts.sticks || 0) + item.count
      }

      // Need: 2 planks + 3 cobblestone for pickaxe
      details.planks = counts.planks || 0
      details.cobblestone = counts.cobblestone || 0
      details.sticks = counts.sticks || 0
      details.hasPlanks = (counts.planks || 0) >= 2
      details.hasCobble = (counts.cobblestone || 0) >= 3

      // Can craft at least one stone pickaxe?
      const hasResources = details.hasPlanks && details.hasCobble
    } catch (e) {
      this._log(`Check resources error: ${e.message}`)
    } finally {
      await this._closeChest()
    }

    return { hasResources, details }
  }

  /**
   * Check if bot has sufficient gear for an expedition WITHOUT going to chests.
   * @returns {{ ready: boolean, missing: string[] }}
   */
  checkInventoryReady () {
    const bot = this._bot
    const PICKAXE_TIERS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe']
    const FOOD_NAMES = /^(bread|cooked_beef|beef|cooked_porkchop|porkchop|cooked_chicken|chicken|cooked_mutton|mutton|cooked_rabbit|rabbit|cooked_salmon|salmon|cooked_cod|cod|baked_potato|potato|carrot|golden_carrot|mushroom_stew|rabbit_stew|apple|golden_apple|enchanted_golden_apple|pumpkin_pie|cookie|dried_kelp|melon_slice|sweet_berries|glow_berries)$/
    const items = bot.inventory.items()
    const _invTier = (tiers) => { for (let i = 0; i < tiers.length; i++) { if (items.some(it => it.name === tiers[i])) return i } ; return tiers.length }
    const _invCount = (re) => items.filter(i => re.test(i.name)).reduce((s, i) => s + i.count, 0)

    const missing = []
    if (_invTier(PICKAXE_TIERS) > 5) missing.push('кирки нет')         // no pickaxe at all
    else if (_invTier(PICKAXE_TIERS) > 3) missing.push('кирка слабая') // worse than stone
    if (_invCount(FOOD_NAMES) < 4) missing.push(`еды мало (${_invCount(FOOD_NAMES)})`)
    return { ready: missing.length === 0, missing }
  }

  /**
   * Restock bot inventory from all chests before heading out.
   * Takes: best pickaxe, best sword, food, torches, best armor.
   * Skips items already in inventory if current is equal or better tier.
   * @returns {Promise<void>}
   */
  async restockForExpedition () {
    const bot = this._bot
    const chestPositions = this._config.getChestPositions()

    const PICKAXE_TIERS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe']
    const SHOVEL_TIERS  = ['netherite_shovel',  'diamond_shovel',  'iron_shovel',  'stone_shovel',  'golden_shovel',  'wooden_shovel']
    const SWORD_TIERS   = ['netherite_sword',   'diamond_sword',   'iron_sword',   'stone_sword',   'golden_sword',   'wooden_sword']
    const ARMOR_SLOTS   = {
      helmet:     { slot: 'head',    tiers: ['netherite_helmet',     'diamond_helmet',     'iron_helmet',     'golden_helmet',     'chainmail_helmet',     'leather_helmet'] },
      chestplate: { slot: 'torso',   tiers: ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'golden_chestplate', 'chainmail_chestplate', 'leather_chestplate'] },
      leggings:   { slot: 'legs',    tiers: ['netherite_leggings',   'diamond_leggings',   'iron_leggings',   'golden_leggings',   'chainmail_leggings',   'leather_leggings'] },
      boots:      { slot: 'feet',    tiers: ['netherite_boots',      'diamond_boots',      'iron_boots',      'golden_boots',      'chainmail_boots',      'leather_boots'] }
    }
    const FOOD_NAMES = /^(bread|cooked_beef|beef|cooked_porkchop|porkchop|cooked_chicken|chicken|cooked_mutton|mutton|cooked_rabbit|rabbit|cooked_salmon|salmon|cooked_cod|cod|baked_potato|potato|carrot|golden_carrot|mushroom_stew|rabbit_stew|apple|golden_apple|enchanted_golden_apple|pumpkin_pie|cookie|dried_kelp|melon_slice|sweet_berries|glow_berries)$/

    const _invTier = (tiers) => {
      const items = bot.inventory.items()
      for (let i = 0; i < tiers.length; i++) {
        if (items.some(it => it.name === tiers[i])) return i
      }
      return tiers.length
    }
    const _invCount = (re) => bot.inventory.items().filter(i => re.test(i.name)).reduce((s, i) => s + i.count, 0)
    const _armorTier = (slot, tiers) => {
      // Check equipped slot first
      const slotIdx = slot === 'head' ? 5 : slot === 'torso' ? 6 : slot === 'legs' ? 7 : 8
      const equipped = bot.inventory.slots[slotIdx]
      if (equipped) {
        const t = tiers.indexOf(equipped.name)
        if (t !== -1) return t
      }
      // Also check inventory (unequipped armor)
      const items = bot.inventory.items()
      for (let i = 0; i < tiers.length; i++) {
        if (items.some(it => it.name === tiers[i])) return i
      }
      return tiers.length
    }

    for (const pos of chestPositions) {
      const needPickaxe      = _invTier(PICKAXE_TIERS) > 0
      const needShovel        = _invTier(SHOVEL_TIERS) > 2
      const needSword         = _invTier(SWORD_TIERS) > 2
      const needFood          = _invCount(FOOD_NAMES) < 8
      const needTorches       = _invCount(/^torch$/) < 16
      const needArmor         = Object.values(ARMOR_SLOTS).some(({ slot, tiers }) => _armorTier(slot, tiers) > 2)
      const needCraftingTable = !bot.inventory.items().some(i => i.name === 'crafting_table')

      this._log(`restock check: pickaxe=${needPickaxe}(tier=${_invTier(PICKAXE_TIERS)}) shovel=${needShovel} sword=${needSword} food=${needFood}(${_invCount(FOOD_NAMES)}) torches=${needTorches}(${_invCount(/^torch$/)}) armor=${needArmor} craftingTable=${needCraftingTable}`)
      if (!needPickaxe && !needShovel && !needSword && !needFood && !needTorches && !needArmor && !needCraftingTable) break

      if (!(await this._openChest(pos))) continue

      try {
        const chestItems = this._chestWindow.containerItems()

        for (const item of chestItems) {
          if (!item) continue

          // Best pickaxe
          if (needPickaxe) {
            const tier = PICKAXE_TIERS.indexOf(item.name)
            if (tier !== -1 && tier < _invTier(PICKAXE_TIERS)) {
              try { await this._chestWindow.withdraw(item.type, null, 1); this._log(`Took ${item.name}`) } catch (_) {}
            }
          }

          // Best shovel
          if (needShovel) {
            const tier = SHOVEL_TIERS.indexOf(item.name)
            if (tier !== -1 && tier < _invTier(SHOVEL_TIERS)) {
              try { await this._chestWindow.withdraw(item.type, null, 1); this._log(`Took ${item.name}`) } catch (_) {}
            }
          }

          // Best sword
          if (needSword) {
            const tier = SWORD_TIERS.indexOf(item.name)
            if (tier !== -1 && tier < _invTier(SWORD_TIERS)) {
              try { await this._chestWindow.withdraw(item.type, null, 1); this._log(`Took ${item.name}`) } catch (_) {}
            }
          }

          // Food
          if (needFood && FOOD_NAMES.test(item.name)) {
            const toTake = Math.min(item.count, 16 - _invCount(FOOD_NAMES))
            if (toTake > 0) {
              try { await this._chestWindow.withdraw(item.type, null, toTake); this._log(`Took food ${item.name} x${toTake}`) } catch (_) {}
            }
          }

          // Torches
          if (needTorches && item.name === 'torch') {
            const toTake = Math.min(item.count, 16 - _invCount(/^torch$/))
            if (toTake > 0) {
              try { await this._chestWindow.withdraw(item.type, null, toTake); this._log(`Took torch x${toTake}`) } catch (_) {}
            }
          }

          // Crafting table (1 per expedition)
          if (needCraftingTable && item.name === 'crafting_table') {
            try { await this._chestWindow.withdraw(item.type, null, 1); this._log(`Took crafting_table`) } catch (_) {}
          }

          // Armor
          if (needArmor) {
            for (const [, { slot, tiers }] of Object.entries(ARMOR_SLOTS)) {
              const tier = tiers.indexOf(item.name)
              if (tier !== -1 && tier < _armorTier(slot, tiers)) {
                try { await this._chestWindow.withdraw(item.type, null, 1); this._log(`Took armor ${item.name}`) } catch (_) {}
              }
            }
          }

          await sleep(TRANSFER_DELAY_MS)
        }
      } catch (e) {
        this._log(`restockForExpedition error at ${pos.x},${pos.y},${pos.z}: ${e.message}`)
      } finally {
        await this._closeChest()
      }
    }

    // Equip armor from inventory
    try {
      for (const [, { slot, tiers }] of Object.entries(ARMOR_SLOTS)) {
        const items = bot.inventory.items()
        for (let i = 0; i < tiers.length; i++) {
          const armorItem = items.find(it => it.name === tiers[i])
          if (armorItem) { await bot.equip(armorItem, slot); break }
        }
      }
    } catch (_) {}

    this._log('restockForExpedition complete')
  }

  /** @private */
  _log (msg) {
    console.log(`[StorageSystem] ${msg}`)
  }
}

module.exports = { StorageSystem }
