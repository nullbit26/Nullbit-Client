'use strict'

const { sleep } = require('../utils/sleep')
const Vec3 = require('vec3')

const CRAFT_TIMEOUT_MS = 15000

/**
 * Crafting System V1
 * MVP: Only stone pickaxe and stone axe from planks/cobblestone
 * No furnace smelting - V2 feature
 */
class CraftingSystem {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('./HomeBaseConfig')} homeBaseConfig
   */
  constructor (bot, homeBaseConfig, brain) {
    this._bot = bot
    this._config = homeBaseConfig
    this._brain = brain || null
  }

  /**
   * Craft planks from any logs in inventory (4 planks per log)
   * @returns {Promise<number>} number of planks crafted
   */
  async craftPlanksFromLogs () {
    const bot = this._bot
    let crafted = 0
    const logs = bot.inventory.items().filter(i => i.name.endsWith('_log') || i.name === 'log')
    for (const log of logs) {
      const plankName = log.name.replace('_log', '_planks')
      const plankItem = bot.registry.itemsByName[plankName] || bot.registry.itemsByName['oak_planks']
      if (!plankItem) continue
      const recipe = bot.recipesFor(plankItem.id, null, 1, null)[0]
      if (!recipe) continue
      try {
        await bot.craft(recipe, log.count)
        crafted += log.count * 4
        this._log(`Crafted ${log.count * 4} ${plankName} from ${log.count} ${log.name}`)
        await sleep(200)
      } catch (e) {
        this._log(`craftPlanksFromLogs failed for ${log.name}: ${e.message}`)
      }
    }
    return crafted
  }

  /**
   * Craft sticks from planks
   * @param {number} count - number of sticks needed (crafts in multiples of 4)
   * @returns {Promise<boolean>}
   */
  async craftSticks (count = 4) {
    const planksNeeded = Math.ceil(count / 4)
    this._log(`Crafting ${count} sticks from ${planksNeeded} planks`)

    try {
      // Find planks recipe (any wood type)
      const plankItem = this._bot.inventory.items().find(i => i.name.includes('planks'))
      if (!plankItem || plankItem.count < planksNeeded) {
        this._log('ERROR: Not enough planks for sticks')
        return false
      }

      const recipe = this._bot.recipesFor(this._bot.registry.itemsByName.stick.id, null, 1, plankItem)[0]
      if (!recipe) {
        this._log('ERROR: No stick recipe found')
        return false
      }

      await this._bot.craft(recipe, Math.ceil(count / 4))
      this._log(`Crafted sticks`)
      await sleep(500)
      return true
    } catch (e) {
      this._log(`Failed to craft sticks: ${e.message}`)
      return false
    }
  }

  /**
   * Craft stone pickaxe
   * Recipe: Cobblestone x3 (top row) + Sticks x2 (middle bottom)
   * @returns {Promise<boolean>}
   */
  async craftStonePickaxe () {
    this._log('Crafting stone pickaxe...')

    try {
      // Check materials
      const cobble = this._bot.inventory.items().find(i => i.name === 'cobblestone')
      const sticks = this._bot.inventory.items().find(i => i.name === 'stick')

      if (!cobble || cobble.count < 3) {
        this._log('ERROR: Need 3 cobblestone')
        return false
      }
      if (!sticks || sticks.count < 2) {
        // Try to craft sticks first
        const crafted = await this.craftSticks(4)
        if (!crafted) return false
      }

      // Find crafting table
      const tablePos = this._config.getCraftingTablePos()
      if (!tablePos) {
        this._log('ERROR: Crafting table position not configured')
        return false
      }

      const tableBlock = this._bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z))
      if (!tableBlock || tableBlock.name !== 'crafting_table') {
        this._log('ERROR: No crafting table at configured position')
        return false
      }

      // Craft
      const pickaxeRecipe = this._bot.recipesFor(this._bot.registry.itemsByName.stone_pickaxe.id, null, 1, tableBlock)[0]
      if (!pickaxeRecipe) {
        this._log('ERROR: No stone_pickaxe recipe found')
        return false
      }

      await this._bot.craft(pickaxeRecipe, 1)
      this._log('Stone pickaxe crafted!')
      await sleep(500)
      return true
    } catch (e) {
      this._log(`Failed to craft pickaxe: ${e.message}`)
      return false
    }
  }

  /**
   * Craft stone axe
   * Recipe: Cobblestone x3 (top-left, top-middle, middle-left) + Sticks x2
   * @returns {Promise<boolean>}
   */
  async craftStoneAxe () {
    this._log('Crafting stone axe...')

    try {
      // Check materials
      const cobble = this._bot.inventory.items().find(i => i.name === 'cobblestone')
      const sticks = this._bot.inventory.items().find(i => i.name === 'stick')

      if (!cobble || cobble.count < 3) {
        this._log('ERROR: Need 3 cobblestone')
        return false
      }
      if (!sticks || sticks.count < 2) {
        await this.craftSticks(4)
      }

      const tablePos = this._config.getCraftingTablePos()
      const tableBlock = this._bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z))
      if (!tableBlock) {
        this._log('ERROR: No crafting table')
        return false
      }

      const axeRecipe = this._bot.recipesFor(this._bot.registry.itemsByName.stone_axe.id, null, 1, tableBlock)[0]
      if (!axeRecipe) {
        this._log('ERROR: No stone_axe recipe found')
        return false
      }

      await this._bot.craft(axeRecipe, 1)
      this._log('Stone axe crafted!')
      await sleep(500)
      return true
    } catch (e) {
      this._log(`Failed to craft axe: ${e.message}`)
      return false
    }
  }

  /**
   * Craft torches from coal/charcoal + sticks (no crafting table needed).
   * 1 coal + 1 stick = 4 torches.
   * @param {number} targetCount - stop crafting when we have this many torches
   * @returns {Promise<number>} number of torches crafted
   */
  async craftTorches (targetCount = 16) {
    const bot = this._bot
    const torchId = bot.registry.itemsByName['torch']?.id
    if (!torchId) return 0

    const currentTorches = bot.inventory.items().find(i => i.name === 'torch')?.count ?? 0
    if (currentTorches >= targetCount) return 0

    const coalItem = bot.inventory.items().find(i => i.name === 'coal' || i.name === 'charcoal')
    if (!coalItem) { this._log('craftTorches: no coal/charcoal'); return 0 }

    const stickItem = bot.inventory.items().find(i => i.name === 'stick')
    if (!stickItem || stickItem.count < 1) {
      const crafted = await this.craftSticks(4)
      if (!crafted) { this._log('craftTorches: no sticks'); return 0 }
    }

    const recipe = bot.recipesFor(torchId, null, 1, null)[0]
    if (!recipe) { this._log('craftTorches: no torch recipe'); return 0 }

    const batchesNeeded = Math.ceil((targetCount - currentTorches) / 4)
    const maxBatches = Math.min(batchesNeeded, coalItem.count)

    try {
      await bot.craft(recipe, maxBatches)
      const newCount = bot.inventory.items().find(i => i.name === 'torch')?.count ?? 0
      const crafted = newCount - currentTorches
      this._log(`craftTorches: crafted ${crafted} torches (now have ${newCount})`)
      await sleep(300)
      return crafted
    } catch (e) {
      this._log(`craftTorches failed: ${e.message}`)
      return 0
    }
  }

  /**
   * Prepare inventory for a mining expedition:
   * - Craft a crafting_table if not already in inventory
   * - Craft sticks: 20 total (16 for torches + 4 for 2 pickaxes)
   * @returns {Promise<{table: boolean, sticks: number}>}
   */
  async prepareForMining () {
    const bot = this._bot
    const result = { table: false, sticks: 0 }

    // Craft crafting_table if not in inventory
    const hasTable = bot.inventory.items().some(i => i.name === 'crafting_table')
    if (!hasTable) {
      // Need 4 planks — try to get from inventory or craft from logs
      await this.craftPlanksFromLogs()
      const planks = bot.inventory.items().find(i => i.name.endsWith('_planks'))
      if (planks && planks.count >= 4) {
        const tableId = bot.registry.itemsByName['crafting_table']?.id
        if (tableId) {
          const recipe = bot.recipesFor(tableId, null, 1, null)[0]
          if (recipe) {
            try {
              await bot.craft(recipe, 1)
              this._log('prepareForMining: crafted crafting_table')
              result.table = true
              await sleep(200)
            } catch (e) {
              this._log(`prepareForMining: table craft failed: ${e.message}`)
            }
          }
        }
      } else {
        this._log('prepareForMining: not enough planks for crafting_table')
      }
    } else {
      result.table = true
    }

    // Craft sticks: need 20 (16 for 64 torches + 4 for 2 pickaxes)
    const STICKS_TARGET = 20
    const currentSticks = bot.inventory.items().find(i => i.name === 'stick')?.count ?? 0
    if (currentSticks < STICKS_TARGET) {
      const need = STICKS_TARGET - currentSticks
      await this.craftPlanksFromLogs()
      const crafted = await this.craftSticks(need)
      const newCount = bot.inventory.items().find(i => i.name === 'stick')?.count ?? 0
      result.sticks = newCount
      if (crafted) this._log(`prepareForMining: sticks now ${newCount}`)
    } else {
      result.sticks = currentSticks
    }

    return result
  }

  /**
   * Auto-craft missing tools based on what's broken/missing
   * @param {{needsPickaxe: boolean, needsAxe: boolean}} requirements
   * @returns {Promise<{pickaxe: boolean, axe: boolean}>}
   */
  async craftMissingTools (requirements) {
    const results = { pickaxe: false, axe: false }

    if (requirements.needsPickaxe) {
      results.pickaxe = await this.craftStonePickaxe()
    }

    if (requirements.needsAxe) {
      results.axe = await this.craftStoneAxe()
    }

    return results
  }

  /**
   * Check what tools are needed
   * @returns {{needsPickaxe: boolean, needsAxe: boolean}}
   */
  checkToolNeeds () {
    const items = this._bot.inventory.items()

    const hasPickaxe = items.some(i => i.name.includes('pickaxe'))
    const hasAxe = items.some(i => i.name.includes('axe'))

    return {
      needsPickaxe: !hasPickaxe,
      needsAxe: !hasAxe
    }
  }

  /** @private */
  _log (msg) {
    try { this._brain?.log?.info?.(`[CraftingSystem] ${msg}`) } catch (_) {}
    console.log(`[CraftingSystem] ${msg}`)
  }
}

module.exports = { CraftingSystem }
