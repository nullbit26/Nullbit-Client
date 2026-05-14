/**
 * Навигационная помощь: raycast, векторный стрейф, LOS для срезания углов пути (vec3).
 * Вызывается после pathfinder на physicsTick.
 */
const { Vec3 } = require('vec3')

const RAY_FEET_HEIGHT = 0.12
const RAY_WAIST_HEIGHT = 0.92
const HORIZ_EPS = 1e-9

/** Горизонтальное направление по yaw сущности (как у pathfinder look). */
function horizontalForward(yaw) {
  const v = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
  return v.normalize()
}

function perpendicularXZ(forwardXZ) {
  const len = Math.hypot(forwardXZ.x, forwardXZ.z)
  if (len < HORIZ_EPS) {
    return { left: new Vec3(1, 0, 0), right: new Vec3(-1, 0, 0) }
  }
  const ux = forwardXZ.x / len
  const uz = forwardXZ.z / len
  return {
    left: new Vec3(-uz, 0, ux),
    right: new Vec3(uz, 0, -ux)
  }
}

/** Не блокируют ходку (рейкасты на «прыжок вперёд» / LOS). Трава давала ложный barrier + ложный stuck. */
function isMovementObstacle(block) {
  if (!block) return false
  const bb = block.boundingBox
  if (!bb || bb === 'empty') return false
  const n = block.name || ''
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return false
  if (/water|lava|bubble_column|kelp_plant|seagrass/.test(n)) return false
  const passThrough = new Set([
    'short_grass',
    'tall_grass',
    'grass',
    'fern',
    'large_fern',
    'dead_bush',
    'sweet_berry_bush',
    'dandelion',
    'poppy',
    'blue_orchid',
    'cornflower',
    'azure_bluet',
    'lily_of_the_valley',
    'sunflower',
    'rose_bush',
    'peony'
  ])
  if (passThrough.has(n)) return false
  return true
}

function raycastHorizontalFrom(bot, yaw, distance, originYOffset) {
  if (!bot?.entity?.position || !bot.world?.raycast) return null
  const origin = bot.entity.position.offset(0, originYOffset, 0)
  const dir = horizontalForward(yaw).normalize()
  return bot.world.raycast(origin, dir, distance, (block) => (isMovementObstacle(block) ? block : null))
}

function preemptiveBarrierAhead(bot, dist, yaw) {
  return !!(raycastHorizontalFrom(bot, yaw, dist, RAY_FEET_HEIGHT) || raycastHorizontalFrom(bot, yaw, dist, RAY_WAIST_HEIGHT))
}

/** Свободное место над головой по Y (без прыжка в пол/потолок угла). */
function hasVerticalHeadroom(bot, upRange = 1.08, startYOffset = 1.02) {
  if (!bot?.entity?.position || !bot.world?.raycast) return true
  const o = bot.entity.position.offset(0, startYOffset, 0)
  const hit = bot.world.raycast(o, new Vec3(0, 1, 0), upRange, (block) =>
    isMovementObstacle(block) ? block : null
  )
  return hit == null
}

/**
 * Обход цилиндра (ствол + крона): несколько высот, старт чуть «назад» от стены — иначе ray из центра
 * сразу попадает в тот же блок и оба стрейфа кажутся заблокированными.
 * Если лучи с обеих сторон бьют в дерево — последний шанс: векторно в сторону цели (cross с forward).
 * @returns {'left'|'right'|null}
 */
function pickLateralEscapeSide(
  bot,
  goalXZ,
  lateralProbeDist = 0.92,
  opts = {}
) {
  if (!bot?.entity?.position || !goalXZ || !bot.world?.raycast) return null
  const backWhenCollided = Number(opts.backWhenCollided ?? 0.24)
  const heights = opts.heights || [0.11, 0.42, 0.92]
  const yaw = bot.entity.yaw
  const fwd = horizontalForward(yaw)
  const collided = !!bot.entity.isCollidedHorizontally
  const pull = collided ? -Math.max(0, backWhenCollided) : Number(opts.feetPullbackNoCollide ?? 0)
  const baseFeet = bot.entity.position.plus(fwd.scaled(pull))
  const { left, right } = perpendicularXZ(fwd)

  const toGoal = goalXZ.minus(bot.entity.position)
  toGoal.y = 0
  const g = toGoal.norm() > 1e-4 ? toGoal.unit() : fwd

  function sideClear(sideUnit) {
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i]
      const o = baseFeet.offset(0, h, 0)
      if (raycastAlongXZ(bot, o, sideUnit, lateralProbeDist) === null) return true
    }
    return false
  }

  function geometryFallback() {
    const cross = fwd.x * g.z - fwd.z * g.x
    return cross >= 0 ? 'left' : 'right'
  }

  const cL = sideClear(left)
  const cR = sideClear(right)
  if (!cL && !cR) return geometryFallback()

  const dotL = g.dot(left)
  const dotR = g.dot(right)
  if (cL && cR) return dotL >= dotR ? 'left' : 'right'
  if (cL) return 'left'
  return 'right'
}

/**
 * При упоре в стену: чистый шаг влево/вправо (рейкаст строго по нормали), кто свободнее и ближе к цели по XZ.
 * @returns {'left'|'right'|null}
 */
function pickPureLateralStrafe(bot, goalXZ, lateralProbeDist = 0.62, originYOffset = 0.42) {
  if (!bot?.entity?.position || !goalXZ) return null
  const yaw = bot.entity.yaw
  const fwd = horizontalForward(yaw)
  const { left, right } = perpendicularXZ(fwd)
  const origin = bot.entity.position.offset(0, originYOffset, 0)
  const toGoal = goalXZ.minus(bot.entity.position)
  toGoal.y = 0
  const g = toGoal.norm() > 1e-4 ? toGoal.unit() : fwd

  function clear(sideUnit) {
    return raycastAlongXZ(bot, origin, sideUnit, lateralProbeDist) === null
  }

  const cL = clear(left)
  const cR = clear(right)
  if (!cL && !cR) return null

  const dotL = g.dot(left)
  const dotR = g.dot(right)
  if (cL && cR) return dotL >= dotR ? 'left' : 'right'
  if (cL) return 'left'
  return 'right'
}

function losTo(bot, eye, targetCenter, margin = 0.38) {
  if (!bot.world?.raycast) return false
  const dir = targetCenter.minus(eye)
  const len = dir.norm()
  if (len < 0.12) return true
  const range = Math.max(0, len - margin)
  const hit = bot.world.raycast(eye, dir.unit(), range, (block) => (isMovementObstacle(block) ? block : null))
  return hit == null
}

/** Raycast вдоль нормализованного XZ-вектора от origin. */
function raycastAlongXZ(bot, origin, dirXZ, distance) {
  if (!bot.world?.raycast) return null
  const len = Math.hypot(dirXZ.x, dirXZ.z)
  if (len < HORIZ_EPS) return null
  const d = new Vec3(dirXZ.x / len, 0, dirXZ.z / len)
  return bot.world.raycast(origin, d, distance, (block) => (isMovementObstacle(block) ? block : null))
}

/** Нормализованный XZ-вектор направления по текущим WASD относительно yaw (как в игре). */
function effectiveMoveDirectionXZ(bot) {
  if (!bot?.entity) return null
  const yaw = bot.entity.yaw
  const f = horizontalForward(yaw)
  const { left, right } = perpendicularXZ(f)
  let x = 0
  let z = 0
  const cs = bot.controlState
  if (cs.forward) {
    x += f.x
    z += f.z
  }
  if (cs.back) {
    x -= f.x
    z -= f.z
  }
  if (cs.left) {
    x += left.x
    z += left.z
  }
  if (cs.right) {
    x += right.x
    z += right.z
  }
  const len = Math.hypot(x, z)
  if (len < 1e-4) return null
  return new Vec3(x / len, 0, z / len)
}

/**
 * Блок по намерению движения ближе maxDist (по лучу на нескольких высотах).
 * @param {number} maxDist макс. длина луча (блоки), «вплотную» — ~0.3
 */
function obstacleAlongMoveIntent(bot, maxDist = 0.32) {
  const dir = effectiveMoveDirectionXZ(bot)
  if (!dir) return false
  const ys = [0.12, 0.46, 0.88]
  for (let i = 0; i < ys.length; i++) {
    const origin = bot.entity.position.offset(0, ys[i], 0)
    if (raycastAlongXZ(bot, origin, dir, maxDist)) return true
  }
  return false
}

/**
 * Какой боковой вектор даёт больше свободного пространства к цели (рейкаст вдоль forward+side blend).
 * @returns 'left' | 'right' | null
 */
function pickStrafeSide(bot, goalXZ, options = {}) {
  const yaw = bot.entity.yaw
  const fwd = horizontalForward(yaw)
  const { left, right } = perpendicularXZ(fwd)
  const toGoal = goalXZ.minus(bot.entity.position)
  toGoal.y = 0
  const maxSide = options.sideProbeDist ?? 0.85
  const originY = options.originYOffset ?? RAY_WAIST_HEIGHT
  const origin = bot.entity.position.offset(0, originY, 0)
  const goalDir = toGoal.norm() > 1e-6 ? toGoal.unit() : fwd

  function scoreSide(sideVec) {
    const blend = fwd.plus(sideVec).normalize()
    const hit = raycastAlongXZ(bot, origin, blend, maxSide)
    if (hit) return -1
    return goalDir.dot(blend)
  }

  const sL = scoreSide(left)
  const sR = scoreSide(right)
  if (sL < 0 && sR < 0) return null
  if (sL >= sR && sL >= 0) return 'left'
  if (sR >= 0) return 'right'
  return null
}

function horizontalSpeed(entity) {
  if (!entity?.velocity) return 0
  const { x, z } = entity.velocity
  return Math.hypot(x, z)
}

function movementKeysActive(bot) {
  const c = bot.controlState
  return !!(c.forward || c.back || c.left || c.right)
}

module.exports = {
  Vec3,
  horizontalForward,
  perpendicularXZ,
  isMovementObstacle,
  preemptiveBarrierAhead,
  hasVerticalHeadroom,
  pickLateralEscapeSide,
  pickPureLateralStrafe,
  losTo,
  pickStrafeSide,
  effectiveMoveDirectionXZ,
  obstacleAlongMoveIntent,
  horizontalSpeed,
  movementKeysActive,
  RAY_FEET_HEIGHT,
  RAY_WAIST_HEIGHT
}
