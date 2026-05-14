'use strict'

const { NavEvents } = require('../../core/EventRegistry')

/**
 * Owns heal attempts during FLEE: single-flight consume + safe-window + backoff.
 */
class HealController {
  /**
   * @param {object} ctx
   * @param {import('mineflayer').Bot} ctx.bot
   * @param {import('events').EventEmitter} ctx.bus
   * @param {any} ctx.config
   * @param {(bot: any, config: any) => number} ctx.getFleeSafeHpThreshold
   * @param {(bot: any) => any} ctx.findBestFoodItem
   * @param {(bot: any, threshold: number) => any} ctx.findBestHealPotion
   * @param {(item: any) => boolean} ctx.isSplashLikePotion
   * @param {(bot: any) => Promise<void>} ctx.equipBestWeapon
   * @param {(ms: number) => Promise<void>} ctx.sleep
   * @param {() => number} ctx.getMsSinceLastFleeNav
   * @param {() => boolean} ctx.isStillInFlee
   * @param {() => void} ctx.emitFleeNav
   * @param {() => void} ctx.emitFleeNavRandom
   */
  constructor (ctx) {
    this._bot = ctx.bot
    this._bus = ctx.bus
    this._config = ctx.config
    this._getFleeSafeHpThreshold = ctx.getFleeSafeHpThreshold
    this._findBestFoodItem = ctx.findBestFoodItem
    this._findBestHealPotion = ctx.findBestHealPotion
    this._isSplashLikePotion = ctx.isSplashLikePotion
    this._equipBestWeapon = ctx.equipBestWeapon
    this._sleep = ctx.sleep
    this._getMsSinceLastFleeNav = ctx.getMsSinceLastFleeNav
    this._isStillInFlee = ctx.isStillInFlee
    this._emitFleeNav = ctx.emitFleeNav
    this._emitFleeNavRandom = ctx.emitFleeNavRandom

    this.reset()
  }

  reset () {
    this._phase = 'IDLE'
    this._safeTickStreak = 0
    this._consumeFailStreak = 0
    this._lastConsumeFailAt = 0
    this._cooldownUntil = 0
  }

  isBusy () {
    return this._phase === 'PREPARE' || this._phase === 'CONSUMING'
  }

  observeSafetyTick (isSafe) {
    if (isSafe) this._safeTickStreak++
    else this._safeTickStreak = 0
  }

  /**
   * @param {{ hpNeedsHeal: boolean, force?: boolean }} params
   * @returns {void}
   */
  tryStart (params) {
    if (this.isBusy()) return
    if (!params?.hpNeedsHeal && !params?.force) return

    const now = Date.now()
    if (now < this._cooldownUntil) return

    if (this._lastConsumeFailAt > 0) {
      const sinceFail = now - this._lastConsumeFailAt
      const base = Number(this._config.combatFleeHealConsumeBackoffMs) || 1000
      const step = Number(this._config.combatFleeHealConsumeBackoffStepMs) || 700
      const max = Number(this._config.combatFleeHealConsumeBackoffMaxMs) || 4500
      const backoffMs = Math.min(max, base + this._consumeFailStreak * step)
      if (sinceFail < backoffMs) return
    }

    const safeWindowTicks = Math.max(1, Number(this._config.combatFleeHealSafeWindowTicks) || 2)
    if (this._safeTickStreak < safeWindowTicks) return

    const minAfterNavMs = Number(this._config.combatFleeHealAfterNavDelayMs) || 3000
    if (this._getMsSinceLastFleeNav() < minAfterNavMs) return

    const thr = this._getFleeSafeHpThreshold(this._bot, this._config)
    const hp = Number(this._bot.health)
    if (!Number.isFinite(hp)) return
    const food = Number(this._bot.food) || 0
    const hpNeedsHeal = hp < thr
    if (!hpNeedsHeal && !params?.force) return

    const pot = this._findBestHealPotion(this._bot, thr)
    const fd = this._findBestFoodItem(this._bot)

    let item = null
    let kind = 'food'
    if (hpNeedsHeal && pot) {
      item = pot
      kind = this._isSplashLikePotion(pot) ? 'splash' : 'drink'
    } else if (
      fd &&
      (food < 20 || (hpNeedsHeal && (fd.name === 'golden_apple' || fd.name === 'enchanted_golden_apple')))
    ) {
      item = fd
      kind = 'food'
    }

    if (!item) return
    if (kind === 'food' && food >= 20 && hp >= thr) return
    if (kind === 'food' && food >= 20 && hpNeedsHeal && pot) {
      item = pot
      kind = this._isSplashLikePotion(pot) ? 'splash' : 'drink'
    }

    this._phase = 'PREPARE'
    void this._consume({ item, kind })
  }

  async _consume ({ item, kind }) {
    let ok = false
    try {
      this._bus.emit(NavEvents.STOP, { reason: 'combat_heal' })
      await this._sleep(90)
      await this._bot.equip(item, 'hand')
      await this._sleep(120)
      this._phase = 'CONSUMING'

      if (kind === 'splash') {
        await this._bot.look(this._bot.entity.yaw, -1.55, true)
        this._bot.activateItem(false)
        await this._sleep(480)
        try { this._bot.deactivateItem() } catch (_) {}
      } else {
        await this._bot.consume()
      }
      ok = true
      await this._equipBestWeapon(this._bot)
    } catch (_) {
      ok = false
    } finally {
      const now = Date.now()
      if (ok) {
        this._consumeFailStreak = 0
        this._lastConsumeFailAt = 0
        this._cooldownUntil = now + (Number(this._config.combatFleeHealSuccessCooldownMs) || 700)
      } else {
        this._consumeFailStreak = Math.min(6, this._consumeFailStreak + 1)
        this._lastConsumeFailAt = now
        this._cooldownUntil = now + (Number(this._config.combatFleeHealFailCooldownMs) || 1400)
      }
      this._phase = 'COOLDOWN'
      if (this._isStillInFlee()) {
        if (ok) this._emitFleeNav()
        else this._emitFleeNavRandom()
      }
      this._phase = 'IDLE'
    }
  }
}

module.exports = { HealController }
