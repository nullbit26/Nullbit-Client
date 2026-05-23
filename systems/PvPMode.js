/**
 * PvP Mode - Specialized combat system for player vs player combat
 * Uses micro/macro navigation with physics tick for optimal performance
 */

const { Vec3 } = require('vec3')

const PvP_MODES = {
  MACRO: 'macro',  // Pathfinder navigation (>5 blocks)
  MICRO: 'micro'   // Direct control (≤5 blocks)
}

const PvP_STATES = {
  ENGAGE: 'engage',    // Aggressive rush
  KITE: 'kite',        // Backpedal with ranged/heal
  TRADE: 'trade'       // Damage trade at low HP
}

class PvPMode {
  constructor (bot, memory, config, bus) {
    this._bot = bot
    this._memory = memory
    this._config = config
    this._bus = bus

    // Target management
    this._target = null
    this._targetId = null
    this._lastTargetPos = null

    // Navigation state
    this._mode = PvP_MODES.MACRO
    this._state = PvP_STATES.ENGAGE
    this._lastDistance = Infinity
    this._hasLineOfSight = false

    // Movement controls
    this._strafeDirection = 0 // -1, 0, 1
    this._strafeChangeTime = 0
    this._lastWTap = 0
    this._isBackpedaling = false

    // Control state locking - prevents conflicts with other systems
    this._controlLocked = false
    this._lockStartTime = 0

    // Shield state
    this._shieldActive = false
    this._shieldActivateTime = 0
    this._shieldDeactivateTime = 0
    this._lastShieldCheck = 0

    // Physics tick (20Hz - every 50ms)
    this._physicsTick = null
    this._lastPhysicsTick = 0

    // Combat timing
    this._lastAttack = 0
    this._lastHealAttempt = 0
    this._isEating = false
    this._engageStartTime = 0
    this._lastCriticalLog = 0

    // Configuration from config.js
    this._IDEAL_DISTANCE = Number(config?.pvpIdealDistance) || 2.9
    this._MICRO_RANGE = Number(config?.pvpMicroRange) || 5.0
    this._PHYSICS_TICK_MS = Number(config?.pvpPhysicsTickMs) || 50
    this._ATTACK_COOLDOWN = Number(config?.pvpAttackCooldown) || 600
    this._KITE_HP_THRESHOLD = Number(config?.pvpKiteHpThreshold) || 8
    this._TRADE_HP_THRESHOLD = Number(config?.pvpTradeHpThreshold) || 4
    this._ENGAGE_HP_ADVANTAGE = Number(config?.pvpEngageHpAdvantage) || 5
    this._ENGAGE_SAFE_HP = Number(config?.pvpEngageSafeHp) || 15
  }

  /**
   * Start PvP mode with target
   */
  async setTarget (target) {
    if (!target || !target.position) return false

    this._target = target
    this._targetId = target.id || target.username
    this._lastTargetPos = target.position.clone()
    this._engageStartTime = Date.now()
    this._killAnnounced = false

    // Voice line on engage
    if (this._voice?.speak) {
      this._voice.speak('Ну, сука, пизда тебе, еблан')
    }

    // HARD LOCK: Stop all other systems and take control
    this._lockControl()

    // Auto-equip best gear (wait for completion)
    await this._equipBestGear()

    // Start physics tick if not running
    if (!this._physicsTick) {
      this._physicsTick = setInterval(() => {
        this._tick()
      }, this._PHYSICS_TICK_MS)
    }

    return true
  }

  /**
   * Auto-equip best armor and weapon from inventory
   */
  async _equipBestGear () {
    try {
      // Order matters: armor -> shield (off-hand) -> weapon (main hand)
      await this._equipBestArmor()
      await this._equipBestShield()
      await this._equipBestWeapon()
    } catch (e) {
      console.log('[PvPMode] Error equipping gear:', e.message)
    }
  }

  /**
   * Equip best weapon (sword > axe)
   */
  async _equipBestWeapon () {
    const WEAPON_TIERS = [
      'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
      'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'
    ]

    const items = this._bot.inventory.items()
    const heldItem = this._bot.heldItem

    // Always equip best weapon (don't skip if holding shield or other items)
    let bestWeapon = null
    let bestTier = Infinity

    for (const item of items) {
      const tier = WEAPON_TIERS.indexOf(item.name)
      if (tier !== -1 && tier < bestTier) {
        bestTier = tier
        bestWeapon = item
      }
    }

    // Check current weapon tier
    const currentTier = heldItem ? WEAPON_TIERS.indexOf(heldItem.name) : Infinity

    // Equip if found better weapon
    if (bestWeapon && bestTier < currentTier) {
      try {
        await this._bot.equip(bestWeapon, 'hand')
        console.log('[PvPMode] Equipped weapon:', bestWeapon.name, '(was:', heldItem?.name || 'empty', ')')
      } catch (e) {
        console.log('[PvPMode] Failed to equip weapon:', e.message)
      }
    } else if (heldItem && WEAPON_TIERS.indexOf(heldItem.name) === -1) {
      // Current item is not a weapon (e.g., shield) - force equip weapon
      const anyWeapon = items.find(i => WEAPON_TIERS.indexOf(i.name) !== -1)
      if (anyWeapon) {
        try {
          await this._bot.equip(anyWeapon, 'hand')
          console.log('[PvPMode] Forced weapon equip:', anyWeapon.name, '(was:', heldItem.name, ')')
        } catch (e) {
          console.log('[PvPMode] Failed to force weapon:', e.message)
        }
      }
    }
  }

  /**
   * Equip best armor from inventory
   */
  async _equipBestArmor () {
    const ARMOR_SLOTS = {
      head: ['netherite_helmet', 'diamond_helmet', 'iron_helmet', 'chainmail_helmet', 'golden_helmet', 'leather_helmet', 'turtle_helmet'],
      torso: ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'leather_chestplate'],
      legs: ['netherite_leggings', 'diamond_leggings', 'iron_leggings', 'chainmail_leggings', 'golden_leggings', 'leather_leggings'],
      feet: ['netherite_boots', 'diamond_boots', 'iron_boots', 'chainmail_boots', 'golden_boots', 'leather_boots']
    }

    const items = this._bot.inventory.items()

    for (const [slot, tiers] of Object.entries(ARMOR_SLOTS)) {
      // Check if slot already has armor
      const currentArmor = this._getArmorInSlot(slot)
      const currentTier = currentArmor ? tiers.indexOf(currentArmor.name) : -1

      if (currentArmor && currentTier === 0) {
        // Already best tier - skip
        console.log('[PvPMode] Already best armor in', slot, ':', currentArmor.name)
        continue
      }

      let equipped = false
      for (const armorName of tiers) {
        const tier = tiers.indexOf(armorName)
        // Skip if current is already better or same
        if (currentTier !== -1 && tier >= currentTier) break

        const armor = items.find(i => i.name === armorName)
        if (armor) {
          try {
            await this._bot.equip(armor, slot)
            console.log('[PvPMode] Equipped armor:', armor.name, 'to', slot)
            equipped = true
            break
          } catch (e) {
            console.log('[PvPMode] Failed to equip', armor.name, ':', e.message)
          }
        }
      }
      if (!equipped && !currentArmor) {
        console.log('[PvPMode] No armor found for slot:', slot)
      }
    }
  }

  /**
   * Equip shield to off-hand
   */
  async _equipBestShield () {
    const items = this._bot.inventory.items()
    const shield = items.find(i => i.name === 'shield')
    const offHand = this._bot.inventory.slots[45]

    if (shield && (!offHand || offHand.name !== 'shield')) {
      try {
        await this._bot.equip(shield, 'off-hand')
        console.log('[PvPMode] Equipped shield to off-hand')
      } catch (e) {
        console.log('[PvPMode] Failed to equip shield:', e.message)
      }
    }
  }

  /**
   * Ensure shield is equipped in off-hand during combat
   */
  _ensureShieldEquipped () {
    // Only check every 500ms to avoid spam
    const now = Date.now()
    if (this._lastShieldCheck && now - this._lastShieldCheck < 500) return
    this._lastShieldCheck = now

    const offHand = this._bot.inventory.slots[45]
    const hasShieldInInventory = this._bot.inventory.items().some(i => i.name === 'shield')

    // If we have shield in inventory but not in off-hand, equip it
    if (hasShieldInInventory && (!offHand || offHand.name !== 'shield') && !this._isEating) {
      this._equipBestShield().catch(() => {})
    }
  }

  /**
   * Get armor currently in slot
   */
  _getArmorInSlot (slot) {
    try {
      const slots = this._bot.inventory.slots
      switch (slot) {
        case 'head': return slots[5]
        case 'torso': return slots[6]
        case 'legs': return slots[7]
        case 'feet': return slots[8]
        default: return null
      }
    } catch (_) {
      return null
    }
  }

  /**
   * Hard lock control states - prevents conflicts with other systems
   */
  _lockControl () {
    if (this._controlLocked) return

    // COMPLETELY disable pathfinder during PvP
    try {
      if (this._bot.pathfinder) {
        this._bot.pathfinder.setGoal(null)
        this._bot.pathfinder.stop()
        // Clear all internal pathfinder state
        this._bot.pathfinder._goal = null
        this._bot.pathfinder._moving = false
        this._bot.pathfinder._path = null
        this._bot.pathfinder._ticksCount = 0
        // Remove all listeners to prevent monitorMovement calls
        this._bot.pathfinder.removeAllListeners()
      }
    } catch (_) {}

    try {
      this._bot.clearControlStates()
    } catch (_) {}

    this._controlLocked = true
    this._lockStartTime = Date.now()

    // Mark bot as under PvP control for other systems
    if (this._bot._pvpControlled !== true) {
      this._bot._pvpControlled = true
    }
  }

  /**
   * Unlock control states
   */
  _unlockControl () {
    if (!this._controlLocked) return

    // Deactivate shield before releasing control
    this._deactivateShield()

    try {
      this._bot.clearControlStates()
    } catch (_) {}

    this._controlLocked = false
    this._lockStartTime = 0

    // Release PvP control flag
    if (this._bot._pvpControlled !== false) {
      this._bot._pvpControlled = false
    }
  }

  /**
   * Check if bot has shield in off-hand
   */
  _hasShield () {
    try {
      const offHand = this._bot.inventory.slots[45] // off-hand slot
      return offHand?.name === 'shield'
    } catch (_) {
      return false
    }
  }

  /**
   * Activate shield (right-click with off-hand)
   */
  _activateShield () {
    if (!this._hasShield() || this._shieldActive || this._isEating) return

    try {
      this._bot.activateItem(true) // true = off-hand
      this._shieldActive = true
      this._shieldActivateTime = Date.now()
    } catch (_) {}
  }

  /**
   * Deactivate shield
   */
  _deactivateShield () {
    if (!this._shieldActive || this._isEating) return

    try {
      this._bot.deactivateItem()
      this._shieldActive = false
      this._shieldDeactivateTime = Date.now()
    } catch (_) {}
  }

  /**
   * Update shield state based on combat situation
   */
  _updateShield (distance, now) {
    // Don't update shield while eating - prevent interrupting heal
    if (this._isEating) return

    if (this._state !== PvP_STATES.KITE) {
      this._deactivateShield()
      return
    }

    // Shield logic for KITE mode
    if (distance < 6) {
      // Close range - activate shield
      this._activateShield()
    } else if (distance > 8) {
      // Safe distance - deactivate shield for speed
      this._deactivateShield()
    } else if (this._shieldActive && now - this._shieldActivateTime > 2000) {
      // Shield active for 2+ seconds - briefly deactivate to reposition
      this._deactivateShield()
      setTimeout(() => {
        if (this._state === PvP_STATES.KITE && this._controlLocked && !this._isEating) {
          this._activateShield()
        }
      }, 200) // Reactivate after 200ms
    }
  }

  /**
   * Clear target and stop PvP mode
   */
  clearTarget () {
    this._target = null
    this._targetId = null
    this._lastTargetPos = null
    this._isEating = false
    this._lastShieldCheck = 0
    this._lastCriticalLog = 0
    this._stopMovement()
    this._unlockControl() // Release control lock
    this._stopPhysicsTick()
  }

  /**
   * Main physics tick - runs every 50ms
   */
  _tick () {
    const now = Date.now()
    this._lastPhysicsTick = now

    if (!this._target || !this._target.position) {
      return
    }

    // Auto-clear if target died or bot died
    if (this._target.health <= 0 || this._bot.health <= 0) {
      // Announce kill if target died and not already announced
      if (this._target.health <= 0 && !this._killAnnounced && this._voice?.speak) {
        this._killAnnounced = true
        this._voice.speak('ха-ха, обоссан лучшим')
      }

      // After kill, heal if HP not full, then stop
      if (this._target.health <= 0 && this._bot.health < 20) {
        console.log('[PvPMode] Victory! HP not full, healing before stop...')
        this._tryHeal(now)
        // Keep running one more tick to allow heal to start, then clear
        setTimeout(() => {
          this.clearTarget()
          console.log('[PvPMode] Healed and stopped after victory')
        }, 2000)
        return
      }

      this.clearTarget()
      return
    }

    // Update distance and line of sight
    const distance = this._getDistance()
    this._hasLineOfSight = this._checkLineOfSight()
    this._lastDistance = distance

    // Debug logging
    if (Math.random() < 0.05) { // Log 5% of ticks to avoid spam
      console.log(`[PvPMode] Tick: dist=${distance.toFixed(2)}, state=${this._state}, locked=${this._controlLocked}, hp=${this._bot.health}`)
    }

    // Determine navigation mode
    this._updateMode(distance)

    // Determine combat state based on HP and distance
    this._updateState(distance)

    // ALWAYS use direct control in PvP mode - no pathfinder conflicts
    this._microCombat()

    // Ensure shield is in off-hand
    this._ensureShieldEquipped()

    // Update shield state
    this._updateShield(this._lastDistance, now)

    // Always look at target
    this._bot.lookAt(this._target.position.offset(0, this._target.height || 1.8, 0))
  }

  /**
   * Update navigation mode based on distance
   */
  _updateMode (distance) {
    const newMode = (distance <= this._MICRO_RANGE && this._hasLineOfSight) 
      ? PvP_MODES.MICRO 
      : PvP_MODES.MACRO

    if (newMode !== this._mode) {
      this._mode = newMode
      this._stopMovement() // Reset movement when switching modes
    }
  }

  /**
   * Update combat state based on HP and tactical situation
   */
  _updateState (distance) {
    const myHp = this._bot.health
    const targetHp = this._target.health || 20
    const hpAdvantage = myHp - targetHp

    let newState

    if (myHp <= this._TRADE_HP_THRESHOLD) {
      // Critical HP - trade damage or die trying
      newState = PvP_STATES.TRADE
    } else if (myHp <= this._KITE_HP_THRESHOLD && distance < 8) {
      // Low HP but safe to kite
      newState = PvP_STATES.KITE
    } else if (hpAdvantage > this._ENGAGE_HP_ADVANTAGE || myHp >= this._ENGAGE_SAFE_HP) {
      // HP advantage or high HP - aggressive engage
      newState = PvP_STATES.ENGAGE
    } else {
      // Even HP - maintain pressure
      newState = PvP_STATES.ENGAGE
    }

    if (newState !== this._state) {
      this._state = newState
      this._isBackpedaling = false
      this._stopMovement()
    }
  }

  /**
   * Micro combat - direct control for close range
   */
  _microCombat () {
    const now = Date.now()
    const distance = this._lastDistance

    // Clear any existing pathfinder goals
    this._bot.pathfinder.setGoal(null)

    // CRITICAL: If HP is critically low, FORCE heal immediately - don't attack
    if (this._bot.health <= 6 && !this._isEating && now - this._lastCriticalLog > 1000) {
      this._lastCriticalLog = now
      console.log('[PvPMode] CRITICAL HP! Forcing heal...')
      this._tryHeal(now)
      // Don't attack, just heal and maybe kite
      if (this._state !== PvP_STATES.KITE) {
        this._state = PvP_STATES.KITE
        this._stopMovement()
      }
      this._microKite(distance, now)
      return // Skip attack, prioritize healing
    }

    switch (this._state) {
      case PvP_STATES.ENGAGE:
        this._microEngage(distance, now)
        break
      case PvP_STATES.KITE:
        this._microKite(distance, now)
        break
      case PvP_STATES.TRADE:
        this._microTrade(distance, now)
        break
    }

    // Attack if cooldown ready AND not eating (prioritize healing)
    if (!this._isEating && now - this._lastAttack >= this._ATTACK_COOLDOWN && distance <= 3.5) {
      this._tryAttack()
    }
  }

  /**
   * Micro engage - aggressive rush
   */
  _microEngage (distance, now) {
    if (!this._controlLocked) return
    this._isBackpedaling = false

    if (distance > this._IDEAL_DISTANCE) {
      // Move forward with sprint
      try {
        this._bot.setControlState('sprint', true)
        this._bot.setControlState('forward', true)
      } catch (_) {}
      
      // Add strafe for unpredictability
      this._updateStrafe(now)
      
      // Jump if approaching
      if (distance < 4) {
        try {
          this._bot.setControlState('jump', true)
        } catch (_) {}
      }
    } else if (distance < this._IDEAL_DISTANCE - 0.5) {
      // Too close - back up slightly
      try {
        this._bot.setControlState('back', true)
      } catch (_) {}
    } else {
      // Ideal distance - just strafe
      try {
        this._bot.setControlState('sprint', false)
      } catch (_) {}
      this._updateStrafe(now)
    }
  }

  /**
   * Micro kite - backpedal while maintaining threat
   */
  _microKite (distance, now) {
    if (!this._controlLocked) return
    this._isBackpedaling = true

    // Always try to heal in kite state regardless of distance
    this._tryHeal(now)

    if (distance < 8) {
      // Backpedal to maintain distance
      try {
        this._bot.setControlState('back', true)
        this._bot.setControlState('sprint', false)
      } catch (_) {}
      
      // Strafe to avoid being predictable
      this._updateStrafe(now)
      
      // Jump occasionally to avoid obstacles
      if (Math.random() < 0.1) {
        try {
          this._bot.setControlState('jump', true)
        } catch (_) {}
      }
    } else {
      // Safe distance - stop moving
      try {
        this._bot.setControlState('back', false)
      } catch (_) {}
    }
  }

  /**
   * Micro trade - damage exchange at critical HP
   */
  _microTrade (distance, now) {
    if (!this._controlLocked) return
    this._isBackpedaling = false

    // W-Tap for knockback
    if (distance <= 3.0 && now - this._lastWTap > 1000) {
      this._performWTap()
      this._lastWTap = now
    }

    // Aggressive forward movement
    try {
      this._bot.setControlState('sprint', true)
      this._bot.setControlState('forward', true)
      this._bot.setControlState('jump', true)
    } catch (_) {}
  }

  
  /**
   * Update strafe direction for unpredictable movement
   */
  _updateStrafe (now) {
    if (!this._controlLocked) return

    // Change strafe direction every 200-800ms
    if (now - this._strafeChangeTime > 200 + Math.random() * 600) {
      this._strafeDirection = Math.random() < 0.33 ? -1 : (Math.random() < 0.5 ? 0 : 1)
      this._strafeChangeTime = now
    }

    // Apply strafe
    try {
      this._bot.setControlState('left', this._strafeDirection === -1)
      this._bot.setControlState('right', this._strafeDirection === 1)
    } catch (_) {}
  }

  /**
   * Perform W-Tap for knockback - proper 50ms pattern
   */
  _performWTap () {
    if (!this._controlLocked) return

    // Pattern: Attack → Stop sprint/forward → Wait 50ms → Resume sprint/forward
    this._bot.setControlState('forward', false)
    this._bot.setControlState('sprint', false)
    
    // Wait exactly 50ms (one server tick) then resume
    setTimeout(() => {
      if (this._controlLocked && this._state === PvP_STATES.TRADE) {
        this._bot.setControlState('forward', true)
        this._bot.setControlState('sprint', true)
      }
    }, 50)
  }

  /**
   * Try to attack target
   */
  _tryAttack () {
    if (!this._target || !this._bot.entity) return

    try {
      this._bot.attack(this._target)
      this._lastAttack = Date.now()
    } catch (error) {
      // Attack failed - target might be invalid
      console.log('[PvPMode] Attack failed:', error.message)
    }
  }

  /**
   * Try to heal - distance-based healing strategy for PvP
   */
  _tryHeal (now) {
    if (this._isEating) return // Already consuming

    // CRITICAL HP: Faster cooldown to survive
    const isCriticalHp = this._bot.health <= 6
    const cooldown = isCriticalHp ? 500 : 1500
    if (now - this._lastHealAttempt < cooldown) return

    this._lastHealAttempt = now
    const distance = this._lastDistance
    const targetPos = this._target?.position?.offset(0, this._target.height || 1.8, 0)

    // DISTANCE < 6 BLOCKS: PRIORITY: splash potions > golden apples
    if (distance < 6) {
      // First try splash potions - they're instant!
      const healingPotions = this._bot.inventory.items().filter(item => item.name === 'splash_potion')
      
      // Debug: see what potions we have
      if (healingPotions.length > 0) {
        const potionTypes = healingPotions.map(p => {
          const nbt = p.nbt?.value || p.nbt
          const potionType = nbt?.Potion?.value || nbt?.potion?.value || ''
          return { name: p.name, type: potionType, display: nbt?.display?.value?.Name?.value }
        })
        console.log('[PvPMode] Found splash potions:', potionTypes)
      }
      
      // Find healing splash potion
      const potion = healingPotions.find(item => {
        const nbt = item.nbt?.value || item.nbt
        const potionType = nbt?.Potion?.value || nbt?.potion?.value || ''
        return potionType.includes('healing') || potionType.includes('instant_health') || 
               potionType.includes('strong_healing') || potionType.includes('strong_instant_health')
      })

      if (potion) {
        // Use splash potion - throw it down at our feet
        console.log('[PvPMode] Healing with splash potion at close range')
        this._useSplashPotion(potion, null)
        return
      }
      
      // No splash potions - use golden apple as fallback
      const gapple = this._bot.inventory.items().find(item => 
        item.name === 'golden_apple' || item.name === 'enchanted_golden_apple'
      )
      if (gapple) {
        console.log('[PvPMode] Healing with', gapple.name, 'at close range')
        this._useFoodItem(gapple, 'golden_apple')
        return
      }
      console.log('[PvPMode] No heal items at close range (no splash/gapple)')
      return
    }

    // DISTANCE > 6 BLOCKS: Can use food/drink potions (safe to eat)
    
    // 1. Try golden apple first
    const gapple = this._bot.inventory.items().find(item => 
      item.name === 'golden_apple' || item.name === 'enchanted_golden_apple'
    )
    if (gapple) {
      console.log('[PvPMode] Healing with', gapple.name, 'at safe distance')
      this._useFoodItem(gapple, 'golden_apple')
      return
    }

    // 2. Try drinkable healing potion
    const drinkPotion = this._bot.inventory.items().find(item => 
      item.name === 'potion' && item.nbt?.value?.Potion?.includes('healing')
    )
    if (drinkPotion) {
      console.log('[PvPMode] Healing with drinkable potion')
      this._useFoodItem(drinkPotion, 'potion')
      return
    }

    // 3. Try regular food (bread, steak, etc.)
    const food = this._bot.inventory.items().find(item => 
      item.name && (item.name.includes('bread') || item.name.includes('steak') || 
                   item.name.includes('cooked') || item.name.includes('apple'))
    )
    if (food) {
      console.log('[PvPMode] Healing with food:', food.name)
      this._useFoodItem(food, 'food')
    } else {
      console.log('[PvPMode] No heal items found in inventory at dist:', distance.toFixed(1))
    }
  }

  /**
   * Use splash potion with proper sequence
   */
  _useSplashPotion (potion, targetPos) {
    // Don't use splash potion while eating - let the heal finish
    if (this._isEating) return

    // 1. Deactivate shield if active
    const wasShieldActive = this._shieldActive
    if (wasShieldActive) {
      this._deactivateShield()
    }

    // 2. Equip splash potion
    this._bot.equip(potion, 'hand')

    // 3. Look straight down (pitch: -90 degrees)
    setTimeout(() => {
      try {
        this._bot.lookAt(this._bot.entity.position.offset(0, -10, 0))
      } catch (_) {}

      // 4. Throw potion with right hand (activateItem(false))
      setTimeout(() => {
        try {
          this._bot.activateItem(false) // false = right hand
        } catch (_) {}

        // 5. Look back at target immediately
        setTimeout(() => {
          if (targetPos && this._controlLocked) {
            this._bot.lookAt(targetPos)
          }

          // 6. Reactivate shield if it was active
          if (wasShieldActive && this._state === PvP_STATES.KITE) {
            setTimeout(() => {
              this._activateShield()
            }, 100)
          }
        }, 50)
      }, 50)
    }, 50)
  }

  /**
   * Use food item (golden apple, drinkable potion, regular food)
   */
  async _useFoodItem (item, itemType) {
    if (this._isEating) return // Prevent double consume
    this._isEating = true

    try {
      await this._bot.equip(item, 'hand')
      await this._bot.consume()
      console.log('[PvPMode] Finished consuming:', item.name)
    } catch (e) {
      console.log('[PvPMode] Failed to eat:', e.message)
    } finally {
      this._isEating = false
      // Re-equip weapon after eating
      const heldItem = this._bot.heldItem
      if (!heldItem || (!heldItem.name.includes('sword') && !heldItem.name.includes('axe'))) {
        console.log('[PvPMode] Re-equipping weapon after eating')
        await this._equipBestWeapon()
      }
      // Re-equip shield to off-hand after eating
      await this._equipBestShield()
    }
  }

  /**
   * Get distance to target
   */
  _getDistance () {
    if (!this._target?.position || !this._bot.entity?.position) return Infinity
    return this._bot.entity.position.distanceTo(this._target.position)
  }

  /**
   * Check line of sight to target
   */
  _checkLineOfSight () {
    if (!this._target?.position || !this._bot.entity?.position) return false

    try {
      // Simple line of sight check using bot's built-in method
      const block = this._bot.blockAt(this._target.position)
      return !block || block.type === 0 || block.transparent
    } catch (error) {
      // If check fails, assume no line of sight
      return false
    }
  }

  /**
   * Stop all movement
   */
  _stopMovement () {
    if (!this._controlLocked) return // Only control if we have lock
    
    const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint']
    controls.forEach(control => {
      try {
        this._bot.setControlState(control, false)
      } catch (_) {}
    })
  }

  /**
   * Stop physics tick
   */
  _stopPhysicsTick () {
    if (this._physicsTick) {
      clearInterval(this._physicsTick)
      this._physicsTick = null
    }
  }

  /**
   * Check if PvP mode is active
   */
  isActive () {
    return this._target !== null && this._physicsTick !== null
  }

  /**
   * Get current state info
   */
  getStatus () {
    return {
      active: this.isActive(),
      target: this._target?.username || this._target?.name,
      mode: this._mode,
      state: this._state,
      distance: this._lastDistance,
      hasLineOfSight: this._hasLineOfSight,
      isBackpedaling: this._isBackpedaling
    }
  }

  /**
   * Cleanup
   */
  destroy () {
    this.clearTarget()
    this._stopPhysicsTick()
  }
}

module.exports = {
  PvPMode,
  PvP_MODES,
  PvP_STATES
}
