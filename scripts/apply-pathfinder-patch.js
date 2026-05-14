/**
 * Обходит ошибку patch-package при отсутствии Git («'git' is not recognized»).
 * Идempotent: если патч уже в node_modules, выходим без изменений.
 * Версия: mineflayer-pathfinder@2.4.5 (как в package.json).
 */
'use strict'

const fs = require('fs')
const path = require('path')

const PKG = path.join(__dirname, '..', 'node_modules', 'mineflayer-pathfinder', 'index.js')

/** Синхронизировано с вставкой в `setGoal` (см. node_modules после postinstall). */
const SETGOAL_STOPPATHING_MARKER = 'come/repath: clear pending pathfinder.stop'

function fail(msg) {
  console.error('[pathfinder-patch]', msg)
  process.exit(1)
}

function run() {
if (!fs.existsSync(PKG)) {
  console.log('[pathfinder-patch] skip: package not installed')
  return
}

const raw = fs.readFileSync(PKG, 'utf8')
if (raw.includes(SETGOAL_STOPPATHING_MARKER)) {
  console.log('[pathfinder-patch] OK — патч актуален')
  return
}

const crlf = raw.includes('\r\n')
let s = raw.replace(/\r\n/g, '\n')

function must(label, needle) {
  if (!s.includes(needle)) fail(`нет ожидаемого фрагмента «${label}» — возможно другая версия pathfinder`)
}

function rep(label, from, to, once = true) {
  must(label, from)
  const n = s.split(from).length - 1
  if (once && n !== 1) fail(`фрагмент «${label}» встречается ${n} раз`)
  if (!once && n === 0) fail(`фрагмент «${label}» не найден`)
  s = s.replace(from, to)
}

if (raw.includes('skipPathSteps')) {
  console.log('[pathfinder-patch] Дополнение: setGoal/stopPathing (поверх уже установленного патча)...')
  rep(
    'setGoal stopPathing',
    `  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    stateGoal = goal`,
    `  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    /* ${SETGOAL_STOPPATHING_MARKER} — иначе resetPath+stop() затирает новую цель после interruptPathfinder() */
    if (goal != null) stopPathing = false
    stateGoal = goal`
  )
  const out = crlf ? s.replace(/\n/g, '\r\n') : s
  fs.writeFileSync(PKG, out, 'utf8')
  console.log('[pathfinder-patch] готово — setGoal/stopPathing добавлен')
  return
}

console.log('[pathfinder-patch] Накладываю изменения без Git (vanilla 2.4.5)...')

rep(
  'path+pathUpdated',
  `  let path = []
  let pathUpdated = false`,
  `  let path = []
  /** Прерывание monitorMovement без сброса цели — для локального восстановления (nav-assist). */
  let pathingPausedUntilPerf = 0
  let pathUpdated = false`
)

const NAV_API = `  /**
   * Отбросить первые узлы активного маршрута (аналог shift), не сбрасывая цель.
   * @returns {number} сколько узлов убрано
   */
  bot.pathfinder.skipPathSteps = (n = 1) => {
    let steps = 1
    if (n !== undefined && n !== null) {
      const parsed = Number(n)
      steps = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 1
    }
    const k = Math.min(steps, path.length)
    let removed = 0
    while (removed < k && path.length > 0) {
      path.shift()
      removed++
    }
    if (removed > 0) lastNodeTime = performance.now()
    return removed
  }

  /** Узел пути по индексу (0 — текущий) или null. */
  bot.pathfinder.pathStepAt = (i = 0) => {
    const idx = Math.max(0, Math.floor(Number(i)) || 0)
    return path[idx] ?? null
  }

  /** Не исполнять шаги пути заданное время (мс); очистка клавиш — поведение как при паузе. */
  bot.pathfinder.pausePathExecution = (ms) => {
    const t = Number(ms)
    pathingPausedUntilPerf = performance.now() + (Number.isFinite(t) ? Math.max(0, t) : 0)
    bot.clearControlStates()
  }

`

rep(
  'isMoving..goto',
  `  bot.pathfinder.isMoving = () => path.length > 0
  bot.pathfinder.isMining = () => digging
  bot.pathfinder.isBuilding = () => placing

  bot.pathfinder.goto = (goal) => {`,
  `  bot.pathfinder.isMoving = () => path.length > 0
  bot.pathfinder.isMining = () => digging
  bot.pathfinder.isBuilding = () => placing

${NAV_API}  bot.pathfinder.goto = (goal) => {`
)

rep(
  'pathFromPlayer reached',
  `    const reached = Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1`,
  `    const reached = Math.hypot(dx, dz) <= 0.7 && Math.abs(dy) < 1`
)

rep(
  'monitorMovement pause gate',
  `        return
      }
    }
    if (stateGoal) {
      if (!stateGoal.isValid()) {
        stop()`,
  `        return
      }
    }
    if (performance.now() < pathingPausedUntilPerf) return
    if (stateGoal) {
      if (!stateGoal.isValid()) {
        stop()`
)

rep(
  'node arrival',
  `    if (Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1) {
      // arrived at next point`,
  `    if (Math.hypot(dx, dz) <= 0.7 && Math.abs(dy) < 1) {
      // arrived at next point`
)

rep(
  'sprint order',
  `    } else if (stateMovements.allowSprinting && physics.canStraightLine(path, true)) {
      bot.setControlState('jump', false)
      bot.setControlState('sprint', true)
    } else if (stateMovements.allowSprinting && physics.canSprintJump(path)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)`,
  `    } else if (stateMovements.allowSprinting && physics.canSprintJump(path)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
    } else if (stateMovements.allowSprinting && physics.canStraightLine(path, true)) {
      bot.setControlState('jump', false)
      bot.setControlState('sprint', true)`
)

rep(
  'setGoal stopPathing',
  `  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    stateGoal = goal`,
  `  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    /* ${SETGOAL_STOPPATHING_MARKER} — иначе resetPath+stop() затирает новую цель после interruptPathfinder() */
    if (goal != null) stopPathing = false
    stateGoal = goal`
)

if (!s.includes('skipPathSteps')) fail('внутренняя ошибка: после замен патч не появился')

const out = crlf ? s.replace(/\n/g, '\r\n') : s
fs.writeFileSync(PKG, out, 'utf8')
console.log('[pathfinder-patch] готово — mineflayer-pathfinder обновлён')
}

run()
