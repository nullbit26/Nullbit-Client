'use strict'

const { CFG, sleep } = require('./constants')
const { predictPosition, distanceTo } = require('./geometry')
const { getCombatSessionActive } = require('./sessionFlags')

/** Часть меты «отпусти спринт на мгновение перед ударом» — без клавиши «назад», чтобы не отъезжать от лица. */
async function sprintResetBeforeMeleeHit (bot) {
  const ms = CFG.SPRINT_RESET_BEFORE_HIT_MS
  if (!ms || ms <= 0) return
  try {
    if (!bot.controlState?.sprint) return
    bot.setControlState('sprint', false)
    await sleep(ms)
  } catch (_) {}
}

async function critAttack (bot, target) {
  const predicted = predictPosition(target, 2)
  const aimPos = predicted.offset(0, (target.height ?? 1.8) * 0.85, 0)

  await bot.lookAt(aimPos, true)

  const dist = distanceTo(bot, target)
  if (dist > CFG.ATTACK_RANGE) return

  // Прыгаем только в ближнем бою (лук/арбалет — без прыжка, чтобы не сбивать прицел)
  const heldItem = bot.heldItem
  const isRangedWeapon = heldItem && (heldItem.name === 'bow' || heldItem.name === 'crossbow')
  if (!isRangedWeapon && bot.entity.onGround && Math.abs(bot.entity.velocity.y) < 0.1) {
    bot.setControlState('jump', true)
    await sleep(CFG.CRIT_JUMP_DELAY_MS)
    bot.setControlState('jump', false)
    await sleep(50)
  }

  await sprintResetBeforeMeleeHit(bot)
  bot.attack(target)
}

async function dodgeArrow (bot) {
  const dir = Math.random() > 0.5 ? 'left' : 'right'
  bot.setControlState(dir, true)
  await sleep(300)
  bot.setControlState(dir, false)
}

/**
 * Боковой шаг в ближнем бою: отпускаем противоположную сторону, смотрим на цель, короткий рывок.
 * Не запускать параллельно несколько раз (см. strafeBusy в attackEntity).
 */
async function strafeStep (bot, target, dir) {
  if (!getCombatSessionActive()) return
  const oppDir = dir === 'left' ? 'right' : 'left'
  bot.setControlState(oppDir, false)
  bot.setControlState(dir, true)
  bot.setControlState('sprint', true)

  if (target && getCombatSessionActive()) {
    try {
      await bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.85, 0), true)
    } catch (_) {}
  }

  const lo = CFG.STRAFE_STEP_MIN_MS
  const hi = CFG.STRAFE_STEP_MAX_MS
  const ms = lo + Math.random() * Math.max(0, hi - lo)
  await sleep(ms)
  if (getCombatSessionActive()) bot.setControlState(dir, false)
}

module.exports = { sprintResetBeforeMeleeHit, critAttack, dodgeArrow, strafeStep }
