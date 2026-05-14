'use strict'

const { goals } = require('mineflayer-pathfinder')
const { GoalFollow, GoalBlock } = goals
const NavMovements = require('../../nav-movements')
const config = require('../../config')
const {
  WEAPON_PRIORITY,
  equipBestArmor,
  equipBestWeapon,
  equipShield,
  pickBestBow
} = require('../../features/combatEquipment')
const {
  augmentMovementsHazards,
  applyCombatCautiousWalk,
  applyCombatNearDangerRetreatTick,
  clearLavaEscapeSteer,
  runLavaEscapeAsync
} = require('../../features/navSafety')

const { CFG, sleep } = require('./constants')
const { distanceTo } = require('./geometry')
const { registerCombatSession, unregisterCombatSession, releaseCombatExclusive } = require('./sessionFlags')
const { combatSessionCleanup } = require('./combatSessionCleanup')
const { computeRangedCombat } = require('../policies/rangedCombatPolicy')
const {
  computeArcherGoal,
  pickRangedMovementGoal,
  minMsUntilNextRangedVolley
} = require('./rangedPolicy')
const { isHeldMeleeWeapon, isHeldRangedWeapon, equipByDistance } = require('./inventoryCombat')
const { isInDanger, detectIncomingArrows } = require('./danger')
const { drinkPotion } = require('./potions')
const { critAttack, dodgeArrow, strafeStep } = require('../executors/meleeExecutor')
const { clearForVolley, performVolley } = require('../executors/rangedExecutor')
const { CombatNavExecutor } = require('../executors/navExecutor')

/**
 * Якорь для дросселя nav: позиция цели, центр GoalNear или XZ+Y бота.
 * @param {object} goal
 * @param {object} target
 * @param {import('mineflayer').Bot} bot
 */
function anchorForCombatNavGoal (goal, target, bot) {
  if (!goal) return null
  if (goal.entity?.position) return goal.entity.position
  if (goal.x != null && goal.y != null && goal.z != null) {
    return { x: goal.x + 0.5, y: goal.y + 0.5, z: goal.z + 0.5 }
  }
  if (goal.x != null && goal.z != null && bot.entity?.position) {
    return { x: goal.x + 0.5, y: bot.entity.position.y, z: goal.z + 0.5 }
  }
  return target?.position ?? null
}

/**
 * @typedef {Object} CombatSessionDeps
 * @property {(bot: import('mineflayer').Bot, entityName: string, entityId?: number|null) => import('prismarine-entity').Entity | null} resolveCombatTarget
 * @property {() => Promise<void>} onRequestDefensiveRestart
 * @property {(session: CombatSession) => void} [clearParentRef]
 */

/**
 * Phase 2: владелец состояния боя и строгий пайплайн приоритетов intent.
 * `tick(snapshot)` / `planIntents` — снимок только читает поля; мутации — в `runCombatTick`.
 */
class CombatSession {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ speak?: Function }} voice
   * @param {{ entityName: string, entityId?: number|null, strategy: string, target: object }} args
   * @param {CombatSessionDeps} deps
   */
  constructor (bot, voice, args, deps) {
    this.bot = bot
    this.voice = voice
    this.entityName = args.entityName
    this.entityId = args.entityId
    this.strategy = args.strategy
    this.target = args.target
    this._deps = deps

    this._running = false
    this._teardownDone = false
    this._intervalId = null
    this._timeoutId = null
    this._recoverPotionBackoffUntil = 0

    this._navExecutor = new CombatNavExecutor(bot)

    this.lowHealthWarned = false
    this.lastDangerVoice = 0
    this.lastPotionTime = 0
    this.lastAttackTime = 0
    this.shieldRaised = false
    this.currentMode = 'melee'
    this.lastPathUpdate = 0
    this.strafeBusy = false
    this.lastStrafeSide = null
    this.modeSwitchBusy = false
    this.lastRangedVolleyAt = 0
    this.rangedVolleyBusy = false
    this.recoverMode = false
    this.lastRecoverPotionTry = 0
    this.recoverPotionBusy = false
    this.hasShield = false
  }

  isRunning () {
    return this._running
  }

  /** @param {string} text */
  dangerVoice (text) {
    if (Date.now() - this.lastDangerVoice > 15000) {
      this.lastDangerVoice = Date.now()
      void this._queueVoice(text)
    }
  }

  /**
   * Чистый план по снимку (приоритет 1→6). Исполнитель в `executePlannedTick`.
   * @param {CombatTickSnapshot} snap
   * @returns {CombatTickPlan}
   */
  planIntents (snap) {
    if (snap.botDead) {
      return { endSession: { reason: 'bot_dead', speak: 'Я погиб в бою.' }, steps: ['END'] }
    }
    if (!snap.target) {
      return { endSession: { reason: 'target_lost', speak: 'Цель недоступна, бой прекращён.' }, steps: ['END'] }
    }
    if (snap.targetDead) {
      return { endSession: { reason: 'target_dead', speak: 'Цель уничтожена, возвращаюсь в строй.' }, steps: ['END'] }
    }
    if (snap.incomingArrows) {
      return { dodgeArrows: true, steps: ['DODGE', 'STOP'] }
    }
    if (snap.danger) {
      return { danger: snap.danger, steps: ['DANGER', 'STOP'] }
    }
    if (snap.recoverMode) {
      return { recover: true, steps: ['RECOVER', 'STOP'] }
    }
    const tail = ['RANGED_VOLLEY', 'NAV', 'MELEE']
    return {
      rangedVolley: snap.rangedVolley,
      navMelee: snap.navMelee,
      steps: tail
    }
  }

  /**
   * Снимок для `planIntents` (без побочных эффектов на bot).
   * @returns {CombatTickSnapshot}
   */
  buildSnapshot () {
    const bot = this.bot
    const target = this.target
    const botDead = bot.health <= 0
    const targetDead = !!(target && target.health !== undefined && target.health <= 0)
    const dist = target ? distanceTo(bot, target) : Infinity
    const isArcherMode = this.strategy === 'archer'
    const rangedCtx = target ? computeRangedCombat(bot, dist, target) : { wantRanged: false, hasRanged: false }
    let wantRanged = rangedCtx.wantRanged
    if (isArcherMode) wantRanged = true
    const now = Date.now()
    const incomingArrows = detectIncomingArrows(bot).length > 0
    const danger = isInDanger(bot)

    const meleeFollowRange =
      this.strategy === 'defensive'
        ? Math.min(11, Math.max(6, Number(config.combatDefensiveMeleeFollowDist) || 8))
        : 2

    const shouldRangedVolley =
      !this.recoverMode &&
      wantRanged &&
      rangedCtx.hasRanged &&
      this.currentMode === 'ranged' &&
      dist <= CFG.RANGED_VOLLEY_MAX_DIST &&
      !this.modeSwitchBusy &&
      !this.rangedVolleyBusy &&
      now - this.lastRangedVolleyAt >= minMsUntilNextRangedVolley(bot, dist) &&
      !(isArcherMode && dist < CFG.ARCHER_MIN_DIST)

    const rangedVolley = shouldRangedVolley
      ? { wantRanged, dist, isArcherMode, rangedCtx }
      : null

    const useMeleeStrafe = dist <= CFG.STRAFE_RANGE && !wantRanged && !isArcherMode
    const now2 = Date.now()
    const shouldUpdatePath =
      (isArcherMode && dist < CFG.ARCHER_MIN_DIST) || now2 - this.lastPathUpdate > 200

    const navMelee = {
      dist,
      wantRanged,
      isArcherMode,
      rangedCtx,
      meleeFollowRange,
      useMeleeStrafe,
      shouldUpdatePath,
      now,
      now2
    }

    return {
      botDead,
      target,
      targetDead,
      dist,
      recoverMode: this.recoverMode,
      incomingArrows,
      danger,
      rangedVolley,
      navMelee
    }
  }

  /**
   * @param {(text: string) => void | Promise<void>} queueVoice
   */
  start (queueVoice, onTickError) {
    this._queueVoice = typeof queueVoice === 'function' ? queueVoice : async () => {}
    this._running = true
    registerCombatSession(this)

    this._intervalId = setInterval(() => {
      void this.runCombatTick().catch((e) => {
        console.error('[PVP] tick:', e?.message || e)
        if (typeof onTickError === 'function') onTickError(e)
      })
    }, CFG.TICK_MS)

    this._timeoutId = setTimeout(() => {
      if (this._running) {
        this.dispose(this.bot, { speakTimeout: true })
      }
    }, CFG.COMBAT_TIMEOUT_MS)
  }

  /**
   * Один тик боя: преамбула (как в legacy) → `planIntents` → исполнение по приоритету.
   */
  async runCombatTick () {
    if (!this._running) return

    const bot = this.bot
    if (bot.health <= 0) {
      this.dispose(bot, { speakLine: 'Я погиб в бою.' })
      return
    }

    this.target =
      (this.target?.id ? bot.entities[this.target.id] : null) ??
      this._deps.resolveCombatTarget(bot, this.entityName, this.entityId)

    if (!this.target) {
      this.dispose(bot, { speakLine: 'Цель недоступна, бой прекращён.' })
      return
    }

    const dist = distanceTo(bot, this.target)
    const wasRecover = this.recoverMode
    if (!this.recoverMode && bot.health <= CFG.RECOVER_ENTER_HEALTH) this.recoverMode = true
    if (this.recoverMode && bot.health >= CFG.RECOVER_EXIT_HEALTH) this.recoverMode = false
    if (this.recoverMode && !wasRecover) {
      try {
        this._navExecutor.clearGoal()
      } catch (_) {}
      bot.setControlState('sprint', false)
      this.lastRecoverPotionTry = 0
      this.lowHealthWarned = true
      void this._queueVoice('Мало здоровья, отхожу и пью зелья.')
    }
    if (!this.recoverMode && wasRecover) {
      void this._queueVoice('Возвращаюсь в бой.')
    }

    const isArcherMode = this.strategy === 'archer'
    if (isArcherMode) {
      const bow = pickBestBow(bot)
      const arrows = bot.inventory.items().find(
        (i) => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow'
      )
      if (!bow || !arrows) {
        this.dispose(bot, { silent: true })
        await this._deps.onRequestDefensiveRestart()
        return
      }
    }

    const rangedCtx = computeRangedCombat(bot, dist, this.target)
    let { wantRanged } = rangedCtx
    if (isArcherMode) wantRanged = true

    const heldItem = bot.heldItem
    if (
      (!isArcherMode &&
        (!isHeldMeleeWeapon(heldItem) && !isHeldRangedWeapon(heldItem))) ||
      (this.recoverMode && !wasRecover)
    ) {
      await equipBestArmor(bot)
      await equipBestWeapon(bot)
      this.hasShield = await equipShield(bot)
    }

    if (
      isArcherMode &&
      !this.recoverMode &&
      rangedCtx.hasRanged &&
      !this.modeSwitchBusy &&
      !this.rangedVolleyBusy
    ) {
      const bowKeep = pickBestBow(bot)
      const h2 = bot.heldItem
      if (bowKeep && (!isHeldRangedWeapon(h2) || h2.name !== bowKeep.name)) {
        try {
          await bot.equip(bowKeep, 'hand')
        } catch (_) {}
      }
    }

    if (!this.recoverMode) {
      const nearbyDrops = Object.values(bot.entities).filter(
        (e) => e.name === 'item' && bot.entity.position.distanceTo(e.position) < 2
      )
      if (nearbyDrops.length) {
        await equipBestArmor(bot)
        const h = bot.heldItem
        if (this.strategy === 'archer') {
          const bowP = pickBestBow(bot)
          const arrP = bot.inventory.items().find((i) =>
            i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow'
          )
          if (bowP && arrP) await bot.equip(bowP, 'hand')
        } else if (!isHeldMeleeWeapon(h) && !isHeldRangedWeapon(h)) {
          await equipBestWeapon(bot)
        }
        this.hasShield = await equipShield(bot)
      }
    }

    if (!this.target || (this.target.health !== undefined && this.target.health <= 0)) {
      this.dispose(bot, { speakLine: 'Цель уничтожена, возвращаюсь в строй.' })
      return
    }

    const distMode = distanceTo(bot, this.target)
    const rangedCtxMode = computeRangedCombat(bot, distMode, this.target)
    let wantRangedMode = rangedCtxMode.wantRanged
    if (isArcherMode) wantRangedMode = true
    const neededMode = wantRangedMode ? 'ranged' : 'melee'
    if (!this.recoverMode && neededMode !== this.currentMode && !this.modeSwitchBusy) {
      this.modeSwitchBusy = true
      equipByDistance(bot, distMode, this.target, { forceRanged: isArcherMode })
        .then((mode) => {
          this.currentMode = mode
          if (mode === 'ranged') this.lastRangedVolleyAt = Date.now()
        })
        .catch((e) => console.warn('[PVP] смена режима оружия:', e?.message || e))
        .finally(() => {
          this.modeSwitchBusy = false
        })
    }

    const snap = this.buildSnapshot()
    const plan = this.planIntents(snap)
    await this.executePlannedTick(plan, snap)
  }

  /**
   * @param {CombatTickPlan} plan
   * @param {CombatTickSnapshot} snap
   */
  async executePlannedTick (plan, snap) {
    const bot = this.bot
    const target = this.target

    if (plan.endSession) {
      const line = plan.endSession.speak
      this.dispose(bot, { speakLine: line })
      return
    }

    if (plan.dodgeArrows) {
      await dodgeArrow(bot)
      return
    }

    if (plan.danger) {
      await this.executeDangerEscape(plan.danger)
      return
    }

    if (plan.recover) {
      await this.executeRecoverTick(target, snap.dist)
      return
    }

    if (plan.rangedVolley) {
      this.fireRangedVolleyAsync(plan.rangedVolley.dist)
    }

    await this.executeNavAndMelee(snap.navMelee, target, snap.dist)
  }

  /** @param {string} danger */
  async executeDangerEscape (danger) {
    const bot = this.bot
    this._navExecutor.clearGoal()
    bot.setControlState('sprint', false)

    if (danger === 'lava') {
      this.dangerVoice('Лава! Выхожу!')
      await runLavaEscapeAsync(bot, { maxMs: 1800 })
    } else if (danger === 'tripwire') {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
      await sleep(500)
      bot.setControlState('jump', false)
      bot.setControlState('sprint', false)
      this.dangerVoice('Ловушка! Прыгаю!')
    } else {
      this.dangerVoice('Опасная зона, отхожу!')
      const tEnd = Date.now() + 700
      while (Date.now() < tEnd && this._running) {
        const still = isInDanger(bot)
        if (!still || still === 'lava' || still === 'tripwire') break
        applyCombatNearDangerRetreatTick(bot)
        await sleep(55)
      }
      clearLavaEscapeSteer(bot)
    }
    console.log('[PVP] Опасность обнаружена — отход', danger)
  }

  async executeRecoverTick (target, dist) {
    const bot = this.bot
    try {
      this._navExecutor.clearGoal()
    } catch (_) {}
    bot.setControlState('sprint', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)

    if (this.hasShield && !this.rangedVolleyBusy) {
      if (dist < CFG.SHIELD_RAISE_DIST + 2.5) {
        try {
          bot.activateItem(true)
        } catch (_) {}
        this.shieldRaised = true
      }
    } else if (this.shieldRaised) {
      try {
        bot.deactivateItem()
      } catch (_) {}
      this.shieldRaised = false
    }

    const nowRec = Date.now()
    if (
      nowRec - this.lastRecoverPotionTry >= CFG.RECOVER_POTION_TRY_MS &&
      !this.recoverPotionBusy &&
      Date.now() >= this._recoverPotionBackoffUntil
    ) {
      this.lastRecoverPotionTry = nowRec
      this.recoverPotionBusy = true
      void (async () => {
        try {
          if (!this._running) return
          const drank = await drinkPotion(bot)
          if (drank) this.lastPotionTime = Date.now()
          else this._recoverPotionBackoffUntil = Date.now() + 5000
        } finally {
          this.recoverPotionBusy = false
        }
      })()
    }

    applyCombatCautiousWalk(bot, { strategy: this.strategy })
  }

  fireRangedVolleyAsync (dist) {
    this.rangedVolleyBusy = true
    this._navExecutor.clearGoal()
    clearForVolley(this.bot)
    void (async () => {
      try {
        if (!this._running || !this.target) return
        const bow = pickBestBow(this.bot)
        if (!bow) return
        const held = this.bot.heldItem
        if (!held || held.name !== bow.name) await this.bot.equip(bow, 'hand')
        await performVolley(this.bot, this.target, dist, bow)
      } catch (e) {
        console.warn('[PVP] дальний залп:', e?.message || e)
      } finally {
        this.rangedVolleyBusy = false
        this.lastRangedVolleyAt = Date.now()
      }
    })()
  }

  /**
   * @param {NonNullable<CombatTickSnapshot['navMelee']>} nav
   * @param {object} target
   * @param {number} dist
   */
  async executeNavAndMelee (nav, target, dist) {
    const bot = this.bot
    const now = nav.now
    const wantRanged = nav.wantRanged
    const isArcherMode = nav.isArcherMode
    const rangedCtx = nav.rangedCtx

    if (bot.health < CFG.LOW_HEALTH && !this.lowHealthWarned) {
      this.lowHealthWarned = true
      void this._queueVoice('Мне нужна помощь, здоровье на исходе!')
    }

    if (bot.health < 14 && Date.now() - this.lastPotionTime > 5000) {
      const drank = await drinkPotion(bot)
      if (drank) this.lastPotionTime = Date.now()
    }

    if (this.hasShield && !this.modeSwitchBusy && !this.rangedVolleyBusy && !isArcherMode) {
      if (dist < CFG.SHIELD_RAISE_DIST && !this.shieldRaised) {
        bot.activateItem(true)
        this.shieldRaised = true
      } else if (dist >= CFG.SHIELD_RAISE_DIST && this.shieldRaised) {
        bot.deactivateItem()
        this.shieldRaised = false
      }
    }

    if (!this.modeSwitchBusy && !this.rangedVolleyBusy) {
      const now2 = nav.now2
      const shouldUpdatePath = nav.shouldUpdatePath
      const useMeleeStrafe = nav.useMeleeStrafe

      if (useMeleeStrafe) {
        this._navExecutor.clearGoal()
      }
      if (shouldUpdatePath) {
        if (dist > CFG.STRAFE_RANGE || wantRanged || isArcherMode) {
          bot.setControlState('left', false)
          bot.setControlState('right', false)
          const pathGoal = isArcherMode
            ? computeArcherGoal(bot, target)
            : wantRanged && rangedCtx.hasRanged
              ? pickRangedMovementGoal(bot, target, dist, rangedCtx)
              : new GoalFollow(target, nav.meleeFollowRange)
          const anchor = anchorForCombatNavGoal(pathGoal, target, bot)
          this._navExecutor.setGoalThrottled(pathGoal, true, anchor)
        } else if (!this.strafeBusy) {
          this._navExecutor.clearGoal()
          this.strafeBusy = true
          const dir =
            this.lastStrafeSide == null
              ? Math.random() > 0.5
                ? 'left'
                : 'right'
              : this.lastStrafeSide === 'left'
                ? 'right'
                : 'left'
          this.lastStrafeSide = dir
          void strafeStep(bot, target, dir).finally(() => {
            this.strafeBusy = false
          })
        }
        this.lastPathUpdate = now2
      }
      if (dist > CFG.STRAFE_RANGE || wantRanged || isArcherMode) {
        bot.setControlState('sprint', true)
      }

      applyCombatCautiousWalk(bot, { strategy: this.strategy })

      const heldNow = bot.heldItem
      const isRangedNow = heldNow && (heldNow.name === 'bow' || heldNow.name === 'crossbow')
      if (!isRangedNow && dist <= CFG.ATTACK_RANGE && (now - this.lastAttackTime) >= CFG.ATTACK_COOLDOWN_MS) {
        await critAttack(bot, target)
        this.lastAttackTime = Date.now()
      }
    }
  }

  wirePathfinderMovements () {
    const bot = this.bot
    const movements = new NavMovements(bot, { cardinalOnly: !!config.pathCardinalOnly })
    movements.canFall = true
    movements.maxDropDown = 4
    movements.allowFreeMotion = false
    movements.canDig = true
    movements.digCost = 10
    movements.allowSprinting = true
    movements.allowParkour = false
    augmentMovementsHazards(bot, movements)
    bot.pathfinder.setMovements(movements)
  }

  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ silent?: boolean, speakLine?: string, speakTimeout?: boolean }} [opts]
   */
  dispose (bot, opts = {}) {
    if (this._teardownDone) return
    this._teardownDone = true
    this._running = false
    if (this._intervalId != null) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
    if (this._timeoutId != null) {
      clearTimeout(this._timeoutId)
      this._timeoutId = null
    }
    try {
      try {
        this._navExecutor.clearGoal()
      } catch (_) {}
      unregisterCombatSession(this)
      combatSessionCleanup(bot)
      if (typeof this._deps.clearParentRef === 'function') {
        try {
          this._deps.clearParentRef(this)
        } catch (_) {}
      }
      if (!opts.silent) {
        if (opts.speakTimeout) void this._queueVoice('Бой прерван по таймауту.')
        else if (opts.speakLine) void this._queueVoice(opts.speakLine)
      }
    } finally {
      releaseCombatExclusive()
    }
  }

  /**
   * Публичный API «тик → намерения» (чистая функция от снимка).
   * @param {CombatTickSnapshot} snapshot
   * @returns {CombatTickPlan}
   */
  tick (snapshot) {
    return this.planIntents(snapshot)
  }
}

/** @typedef {Object} CombatTickSnapshot */
/** @typedef {Object} CombatTickPlan */

module.exports = { CombatSession }
