/**
 * Общая навигационная осторожность: край обрыва, лава/огонь рядом, blocksToAvoid для pathfinder.
 * Математика опасностей — в `navigation/HazardEvaluator.js`; здесь политика тиков / WASD.
 * Бой (attackEntity) владеет sneak/sprint на своём интервале — глобальный слой не трогает бота при активной PvP-сессии.
 */
const { HazardEvaluator, HAZARD_CFG } = require('../navigation/HazardEvaluator')

const hazard = new HazardEvaluator()

/** @deprecated use `HAZARD_CFG` from HazardEvaluator — оставлено для совместимых импортов */
const NAV_SAFETY_CFG = HAZARD_CFG

function augmentMovementsHazards (bot, movements) {
  hazard.augmentMovementsHazards(bot, movements)
}

function evaluateCautiousWalk (bot) {
  return hazard.evaluateCautiousWalk(bot)
}

/**
 * Боевой тик: осторожная ходьба, кроме стратегии stealth (там sneak задаётся отдельно).
 */
function applyCombatCautiousWalk (bot, { strategy }) {
  if (strategy === 'stealth') return
  if (evaluateCautiousWalk(bot)) {
    bot.setControlState('sneak', true)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
  } else {
    bot.setControlState('sneak', false)
  }
}

/**
 * Follow / guard / come / idle path: после nav-assist, без конфликта с PvP (combat владеет клавишами).
 */
function applyGlobalCautiousWalk (bot) {
  if (!bot.entity?.position) return
  if (evaluateCautiousWalk(bot)) {
    bot.setControlState('sneak', true)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
  } else {
    bot.setControlState('sneak', false)
  }
}

function touchesLavaOrInLava (bot) {
  return hazard.touchesLavaOrInLava(bot)
}

function getHazardRepulsionWorldDirXZ (bot, radius) {
  return hazard.getHazardRepulsionWorldDirXZ(bot, radius)
}

function getPathfinderGoalDirXZ (bot) {
  return hazard.getPathfinderGoalDirXZ(bot)
}

function getCliffRetreatDirXZ (bot) {
  return hazard.getCliffRetreatDirXZ(bot)
}

function blendDetourXZ (goal, repel) {
  return hazard.blendDetourXZ(goal, repel)
}

function clampDirNonTowardHazard (dir, repel) {
  return hazard.clampDirNonTowardHazard(dir, repel)
}

/**
 * Мировой XZ (|dir|≈1) → клавиши относительно yaw. Без прыжка — у лавы/кромки не подпрыгиваем.
 */
function worldXZToControls (bot, dir, { allowSprint = false } = {}) {
  const yaw = bot.entity.yaw ?? 0
  if (!dir) {
    bot.setControlState('forward', true)
    bot.setControlState('right', true)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('jump', false)
    bot.setControlState('sprint', false)
    return
  }
  const fx = -Math.sin(yaw)
  const fz = Math.cos(yaw)
  const rx = Math.cos(yaw)
  const rz = Math.sin(yaw)
  const df = dir.x * fx + dir.z * fz
  const dr = dir.x * rx + dir.z * rz
  const t = 0.18
  let forward = df > t
  let back = df < -t
  let right = dr > t
  let left = dr < -t
  if (!forward && !back && !right && !left) {
    const dead = 0.04
    if (Math.abs(df) > dead || Math.abs(dr) > dead) {
      if (Math.abs(df) >= Math.abs(dr)) {
        if (df > 0) forward = true
        else back = true
      } else if (dr > 0) right = true
      else left = true
    }
  }
  bot.setControlState('forward', forward)
  bot.setControlState('back', back)
  bot.setControlState('right', right)
  bot.setControlState('left', left)
  bot.setControlState('jump', false)
  bot.setControlState('sprint', allowSprint && df > 0.42)
}

function clearLavaEscapeSteer (bot) {
  bot.setControlState('forward', false)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('jump', false)
}

function applyLavaEscapeSteer (bot) {
  if (!touchesLavaOrInLava(bot)) return
  if (typeof bot.pathfinder?.setGoal === 'function') bot.pathfinder.setGoal(null)
  const dir = getHazardRepulsionWorldDirXZ(bot, NAV_SAFETY_CFG.LAVA_ESCAPE_SCAN_RADIUS)
  const allowSprint = !!bot.entity.isInLava
  if (!dir) {
    worldXZToControls(bot, null, { allowSprint: false })
    bot.setControlState('sneak', true)
    return
  }
  worldXZToControls(bot, dir, { allowSprint })
  if (bot.entity.isInLava) bot.setControlState('sneak', false)
  else bot.setControlState('sneak', true)
}

function applyGlobalLavaEscapeIfNeeded (bot) {
  const touching = touchesLavaOrInLava(bot)
  if (touching) {
    applyLavaEscapeSteer(bot)
    bot._navSafetyWasLavaEscape = true
    return true
  }
  if (bot._navSafetyWasLavaEscape) {
    clearLavaEscapeSteer(bot)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    bot._navSafetyWasLavaEscape = false
  }
  return false
}

function applyProactiveHazardDetourSteer (bot) {
  if (!evaluateCautiousWalk(bot)) return false
  if (touchesLavaOrInLava(bot)) return false
  if (typeof bot.pathfinder?.isMoving === 'function' && bot.pathfinder.isMoving()) return false

  const repelWide =
    getHazardRepulsionWorldDirXZ(bot, NAV_SAFETY_CFG.HAZARD_DETOUR_SCAN_RADIUS) ||
    getHazardRepulsionWorldDirXZ(bot, NAV_SAFETY_CFG.LAVA_ESCAPE_SCAN_RADIUS)
  const repel = repelWide || getCliffRetreatDirXZ(bot)
  const goal = getPathfinderGoalDirXZ(bot)
  let dir = blendDetourXZ(goal, repel) || repel || goal
  if (!dir) return false
  if (repel) dir = clampDirNonTowardHazard(dir, repel)

  worldXZToControls(bot, dir, { allowSprint: false })
  bot.setControlState('sneak', true)
  bot.setControlState('sprint', false)
  bot.setControlState('jump', false)
  return true
}

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function runLavaEscapeAsync (bot, { maxMs = 1600 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs && touchesLavaOrInLava(bot)) {
    applyLavaEscapeSteer(bot)
    await sleep(45)
  }
  clearLavaEscapeSteer(bot)
  bot.setControlState('sprint', false)
  bot.setControlState('jump', false)
}

function applyCombatNearDangerRetreatTick (bot) {
  const repel =
    getHazardRepulsionWorldDirXZ(bot, NAV_SAFETY_CFG.HAZARD_DETOUR_SCAN_RADIUS) ||
    getCliffRetreatDirXZ(bot)
  if (!repel) {
    worldXZToControls(bot, null, { allowSprint: false })
  } else {
    worldXZToControls(bot, repel, { allowSprint: false })
  }
  bot.setControlState('sneak', true)
  bot.setControlState('jump', false)
  bot.setControlState('sprint', false)
}

module.exports = {
  NAV_SAFETY_CFG,
  augmentMovementsHazards,
  evaluateCautiousWalk,
  applyCombatCautiousWalk,
  applyGlobalCautiousWalk,
  touchesLavaOrInLava,
  applyGlobalLavaEscapeIfNeeded,
  applyProactiveHazardDetourSteer,
  applyCombatNearDangerRetreatTick,
  clearLavaEscapeSteer,
  runLavaEscapeAsync,
  /** @type {import('../navigation/HazardEvaluator').HazardEvaluator} */
  getHazardEvaluator: () => hazard
}
