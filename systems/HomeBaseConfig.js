'use strict'

/**
 * Home Base Configuration
 * MVP V1: Hardcoded coordinates or set via 'тут база' command
 */
class HomeBaseConfig {
  constructor () {
    // Default: null until set by command or config
    this._chestPos = null // { x, y, z } - primary chest (first found)
    this._chestPositions = [] // all chests in base radius
    this._craftingTablePos = null // { x, y, z }
    this._spawnPos = null // { x, y, z } - return point after crafting
  }

  /**
   * Set base location (called by 'тут база' command)
   * @param {{x,y,z}} chestPos - chest location
   * @param {{x,y,z}} craftingTablePos - crafting table location
   */
  setBaseLocation (chestPos, craftingTablePos, allChestPositions = []) {
    this._chestPos = { ...chestPos }
    this._chestPositions = allChestPositions.length > 0 ? allChestPositions.map(p => ({ ...p })) : [{ ...chestPos }]
    this._craftingTablePos = { ...craftingTablePos }
    this._spawnPos = { ...chestPos, y: chestPos.y + 1 }
    console.log(`[HomeBaseConfig] Base set: ${this._chestPositions.length} chest(s), table(${craftingTablePos.x},${craftingTablePos.y},${craftingTablePos.z})`)
  }

  /**
   * Scan for all chests within radius of the base and update _chestPositions.
   * @param {import('mineflayer').Bot} bot
   * @param {number} radius
   */
  scanNearbyChests (bot, radius = 10) {
    if (!this._chestPos) return
    const cx = this._chestPos.x
    const cy = this._chestPos.y
    const cz = this._chestPos.z
    const found = bot.findBlocks({
      matching: b => b && b.name.includes('chest'),
      maxDistance: radius,
      count: 32
    })
    const positions = found
      .map(vec => ({ x: vec.x, y: vec.y, z: vec.z }))
      .filter(p => Math.abs(p.x - cx) <= radius && Math.abs(p.y - cy) <= radius && Math.abs(p.z - cz) <= radius)
    if (positions.length > 0) {
      this._chestPositions = positions
      console.log(`[HomeBaseConfig] scanNearbyChests: found ${positions.length} chest(s) in radius ${radius}`)
    }
  }

  /**
   * Scan for chests and crafting table near bot's current position.
   * Updates chest list and crafting table if found. Saves to file.
   * @param {import('mineflayer').Bot} bot
   * @param {number} radius
   * @param {string} [configPath]
   */
  scanNearbyBase (bot, radius = 25, configPath = null) {
    const botPos = bot.entity?.position
    if (!botPos) return

    // Scan chests
    const chestVecs = bot.findBlocks({
      matching: b => b && (b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel'),
      maxDistance: radius,
      count: 64
    })
    if (chestVecs.length > 0) {
      const newChests = chestVecs.map(v => ({ x: v.x, y: v.y, z: v.z }))
      // Merge with existing, deduplicate by key
      const existing = new Map(this._chestPositions.map(p => [`${p.x},${p.y},${p.z}`, p]))
      for (const p of newChests) existing.set(`${p.x},${p.y},${p.z}`, p)
      this._chestPositions = [...existing.values()]
      if (!this._chestPos) this._chestPos = newChests[0]
      console.log(`[HomeBaseConfig] scanNearbyBase: ${newChests.length} chest(s) found, total=${this._chestPositions.length}`)
    }

    // Scan crafting table
    const tableVecs = bot.findBlocks({
      matching: b => b && b.name === 'crafting_table',
      maxDistance: radius,
      count: 1
    })
    if (tableVecs.length > 0) {
      const t = tableVecs[0]
      this._craftingTablePos = { x: t.x, y: t.y, z: t.z }
      if (!this._spawnPos) this._spawnPos = { x: t.x, y: t.y + 1, z: t.z }
      console.log(`[HomeBaseConfig] scanNearbyBase: crafting_table at (${t.x},${t.y},${t.z})`)
    }

    if (configPath && (chestVecs.length > 0 || tableVecs.length > 0)) {
      this.saveToConfig(configPath)
    }
  }

  /** @returns {boolean} */
  isConfigured () {
    return this._chestPos !== null && this._craftingTablePos !== null
  }

  /** @returns {{x,y,z}|null} */
  getChestPos () { return this._chestPos }

  /** @returns {{x,y,z}[]} */
  getChestPositions () { return this._chestPositions.length > 0 ? this._chestPositions : (this._chestPos ? [this._chestPos] : []) }

  /** @returns {{x,y,z}|null} */
  getCraftingTablePos () { return this._craftingTablePos }

  /** @returns {{x,y,z}|null} */
  getSpawnPos () { return this._spawnPos }

  /**
   * Load from config file or use defaults
   */
  loadFromConfig (configPath) {
    try {
      const fs = require('fs')
      if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        if (data.chestPos && data.craftingTablePos) {
          this._chestPos = data.chestPos
          this._chestPositions = data.chestPositions || [data.chestPos]
          this._craftingTablePos = data.craftingTablePos
          this._spawnPos = data.spawnPos || { ...data.chestPos, y: data.chestPos.y + 1 }
          console.log('[HomeBaseConfig] Loaded from file')
        }
      }
    } catch (e) {
      console.warn('[HomeBaseConfig] Failed to load, using defaults')
    }
  }

  /**
   * Save current config to file
   */
  saveToConfig (configPath) {
    try {
      const fs = require('fs')
      const data = {
        chestPos: this._chestPos,
        chestPositions: this._chestPositions,
        craftingTablePos: this._craftingTablePos,
        spawnPos: this._spawnPos
      }
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2))
      console.log('[HomeBaseConfig] Saved to file')
    } catch (e) {
      console.error('[HomeBaseConfig] Failed to save:', e.message)
    }
  }
}

module.exports = { HomeBaseConfig }
