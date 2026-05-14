/**
 * Движение бота (pathfinder + режимы follow/guard/come + ручные вмешательства).
 *
 * Потоки данных:
 * - Каждый physicsTick: `events` (recordNavProgress, repath…) → затем mineflayer-pathfinder monitorMovement →
 *   затем `tickNavAssist` (inject_allowed, последний listener): ray-jump, peel, smart-stuck, отскок от стены (wall stick).
 * - Legacy: tickPathStallEscape / handleAntiStuck — только если navAssistLegacy* в config.
 * - path_update: `onPathfinderUpdate` → handleStuckRecovery (тиковый throttle + recoveryGlobalMin / cross-context).
 * - Цели: GoalFollow (follow/guard), GoalNear (come / descend / gotoNearCoords). Ручная копка: tryMineBarrierAhead.
 *
 * Внешний бой (attackEntity) может подменять pathfinder Movements на время сессии; после боя movement снова
 * вызывает setupMovements из combat/idle при необходимости.
 * снова вызвать setupMovements + repath (пока не автоматизировано здесь).
 */
const minecraftData = require('minecraft-data')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const NavMovements = require('../nav-movements')
const { applyNaturalDigBlacklist, barrierBreakPriority } = require('../natural-dig-policy')
const {
  losTo,
  pickStrafeSide,
  pickLateralEscapeSide,
  preemptiveBarrierAhead,
  hasVerticalHeadroom,
  movementKeysActive,
  obstacleAlongMoveIntent
} = require('../nav-assist')
const AntiStuck = require('../navigation/AntiStuck')

module.exports = function createMovementActions(bot, deps) {
  const { config, state, utils, resetStuckState } = deps
  const { log, getPlayerEntity, getFrontBlock, getFeetBlock } = utils

  let mcData = null
  let movement = null
  /** PATH_DIG_PREFER_WALK: копка в A* только после noPath/timeout при «ходьбе без копки». */
  let pathfinderDigUnlocked = false
  /** Не спамить nudge вниз из кроны (см. tryMineBarrierAhead). */
  let lastCanopyDescendAt = 0

  const OBSTACLE_RETRY_WINDOW_MS = 4500
  const OBSTACLE_DIG_FAIL_BLOCK_MS = 8000
  const OBSTACLE_RECOVERY_SUPPRESS_DIG_MS = 1100

  function obstacleBlockSignature(pos, blockName) {
    const x = Math.floor(pos.x)
    const y = Math.floor(pos.y)
    const z = Math.floor(pos.z)
    return `${x}|${y}|${z}|${blockName || ''}`
  }

  function resetObstacleRecovery() {
    state.lastObstacleSignature = ''
    state.lastObstaclePos = null
    state.lastObstacleName = ''
    state.lastObstacleDetectedAt = 0
    state.obstacleAttemptCount = 0
    state.obstacleBlockedSig = ''
    state.obstacleBlockedUntil = 0
    state.obstacleConsecutiveDigFails = 0
    state.lastObstacleForcedRepathAt = 0
  }

  /** Регистрируем препятствие при старте ручной копки (один блок — один счётчик серии). */
  function registerObstacle(blockName, position) {
    const sig = obstacleBlockSignature(position, blockName)
    const now = Date.now()
    if (sig === state.lastObstacleSignature && now - state.lastObstacleDetectedAt < 15000) {
      state.obstacleAttemptCount += 1
    } else {
      state.obstacleAttemptCount = 1
    }
    state.lastObstacleSignature = sig
    state.lastObstacleName = blockName || ''
    state.lastObstaclePos = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z)
    }
    state.lastObstacleDetectedAt = now
  }

  function shouldRetryObstacle(position, name) {
    const sig = obstacleBlockSignature(position, name)
    const now = Date.now()
    if (now < state.obstacleRecoveryUntil) {
      if (config.debugMovement) log('[recovery] obstacle ignored until cooldown expires')
      return false
    }
    if (state.obstacleBlockedSig && state.obstacleBlockedSig === sig && now < state.obstacleBlockedUntil) {
      log('[recovery] obstacle ignored until cooldown expires')
      return false
    }
    if (
      sig === state.lastObstacleSignature &&
      state.obstacleAttemptCount >= 2 &&
      now - state.lastObstacleDetectedAt < OBSTACLE_RETRY_WINDOW_MS
    ) {
      log('[stuck] no progress, blocking retry')
      return false
    }
    return true
  }

  function cancelActiveDig() {
    if (bot.targetDigBlock && typeof bot.stopDigging === 'function') bot.stopDigging()
  }

  /** Единая точка: отменить копку, остановить pathfinder, отпустить ручные клавиши (pathfinder снова может взять управление). */
  function interruptPathfinder() {
    cancelActiveDig()
    if (typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop()
    else bot.pathfinder?.setGoal(null)
    clearWalkControls()
  }

  /**
   * Общий сброс при застревании: отмена копки, стоп pathfinder, принудительный repath / спуск к цели.
   * Не вызывает bot.dig — копка только через tryMineBarrierAhead и только если shouldRetryObstacle.
   * @returns {boolean} true если recovery реально выполнен (не уперся в cooldown).
   */
  function handleStuckRecovery(context) {
    const now = Date.now()
    const ctx = String(context || '')
    const globalMin = Number(config.recoveryGlobalMinMs) || 2200
    const loudCooldown =
      ctx === 'path_stall' ||
      ctx === 'anti_stuck_repath' ||
      ctx === 'anti_stuck_max_nudge' ||
      ctx === 'obstacle_repeat'
    if (now - state.lastRecoveryGlobalAt < globalMin) {
      if (loudCooldown) log('[tuning] cooldown blocking repeated reset', ctx || 'global-min')
      return false
    }
    const cross = Number(config.recoveryCrossContextMinMs) || 4000
    const prev = String(state.lastRecoveryContext || '')
    const sincePrev = now - state.lastRecoveryGlobalAt
    if (ctx === 'path_stall' && prev.startsWith('anti_stuck') && sincePrev < cross) {
      log('[tuning] cooldown blocking repeated reset', 'stall-after-antistuck')
      return false
    }
    if ((ctx === 'anti_stuck_repath' || ctx === 'anti_stuck_max_nudge') && prev === 'path_stall' && sincePrev < cross) {
      log('[tuning] cooldown blocking repeated reset', 'antistuck-after-stall')
      return false
    }
    /** Два подряд recovery без recordNavProgress — не повторять тот же шторм сбросов. */
    const burstMax = 2
    const noProgWindow = 7500
    const burstDistEps = Number(config.pathStallProgressEpsilon) || 0.15
    if (
      (state.recoveryBurstCount || 0) >= burstMax &&
      now - state.lastProgressAt < noProgWindow &&
      bot.entity?.position &&
      state.lastProgressPos &&
      bot.entity.position.distanceTo(state.lastProgressPos) < burstDistEps
    ) {
      log('[tuning] cooldown blocking repeated reset', 'burst-no-progress')
      return false
    }

    interruptPathfinder()
    state.repathCooldownTicks = 0
    state.isRecovering = false
    state.recoverUntil = 0
    state.pathStallTicks = 0
    log('[recovery] fallback path reset', context || '')

    const targetEnt =
      state.mode === 'follow' || state.mode === 'guard' || state.mode === 'come'
        ? getPlayerEntity(state.targetUsername)
        : null

    let descended = false
    if (targetEnt && bot.entity && targetEnt.position.y < bot.entity.position.y - 1.05) {
      descended = tryDescendFromCanopy(targetEnt)
    }
    if (!descended) {
      if (state.mode === 'follow' || state.mode === 'guard') repathToTarget(true)
      else if (state.mode === 'come') refreshComeGoal()
    }
    state.obstacleRecoveryUntil = Date.now() + OBSTACLE_RECOVERY_SUPPRESS_DIG_MS

    state.lastRecoveryGlobalAt = Date.now()
    state.lastRecoveryContext = ctx
    state.recoveryBurstCount = (state.recoveryBurstCount || 0) + 1
    if (ctx === 'path_stall') {
      state.stallRecoveryGraceUntil = Date.now() + (Number(config.stallRecoveryGraceMs) || 900)
      log('[tuning] extending progress window')
    }
    return true
  }

  /** Прогресс к цели или смещение — сбрасывает серию «одно и то же препятствие». */
  function recordNavProgress() {
    if (!bot.entity) return
    const p = bot.entity.position
    const now = Date.now()
    if (!state.lastProgressPos) {
      state.lastProgressPos = p.clone()
      state.lastProgressAt = now
    }
    const moveEps = Number(config.pathStallProgressEpsilon) || 0.15
    /** В guard чуть ниже порог — микродвижение к цели чаще сбрасывает recoveryBurst / stuck. */
    const goalEps = state.mode === 'guard' ? 0.065 : 0.09
    let progressed = false
    const moved = state.lastProgressPos ? p.distanceTo(state.lastProgressPos) : 999
    if (moved > moveEps) progressed = true

    const targetEnt =
      state.mode === 'follow' || state.mode === 'guard' || state.mode === 'come'
        ? getPlayerEntity(state.targetUsername)
        : null
    if (targetEnt) {
      const d = p.distanceTo(targetEnt.position)
      if (state.lastGoalProgressDist != null && state.lastGoalProgressDist - d > goalEps) progressed = true
      state.lastGoalProgressDist = d
    }

    if (progressed) {
      state.lastProgressPos = p.clone()
      state.lastProgressAt = now
      state.navAssistSmartAnchorPos = p.clone()
      state.navAssistSmartAnchorMs = now
      const gv = bot.pathfinder?.goal ? getPathfinderGoalVec3() : null
      if (gv) state.navAssistGoalDistAnchor = p.distanceTo(gv)
      state.navAssistVelocityStallSincePerf = performance.now()
      state.obstacleRecoveryUntil = 0
      resetObstacleRecovery()
      state.recoveryBurstCount = 0
      state.stuckCount = 0
      state.antiStuckScheduled = false
      if (state.antiStuckTimeoutId != null) {
        try {
          clearTimeout(state.antiStuckTimeoutId)
        } catch (_) {}
        state.antiStuckTimeoutId = null
      }
    }
  }

  /** noPath / timeout / partial из pathfinder — общий recovery вместо немедленной копки. */
  function onPathfinderUpdate(res) {
    const st = res?.status
    if (!(st === 'noPath' || st === 'timeout' || st === 'partial')) return
    /** `partial` часто идёт каждые тики A* — сброс пути ломает проход углов и даёт цикл с логами recovery. */
    if (st === 'partial' && !config.pathRecoverOnPartial) return
    if (!(state.mode === 'follow' || state.mode === 'guard' || state.mode === 'come')) return
    if (state.tickCounter - state.lastNoPathRepathTick < config.pathNoPathRepathCooldownTicks) return
    state.lastNoPathRepathTick = state.tickCounter
    if (st === 'noPath') {
      const minMs = Number(config.pathNoPathRecoveryMinMs)
      if (Number.isFinite(minMs) && minMs > 0) {
        const t0 = state.lastNoPathStuckRecoveryAt || 0
        if (t0 > 0 && Date.now() - t0 < minMs) return
      }
    }
    if (handleStuckRecovery(`path_${st}`)) {
      if (st === 'noPath') state.lastNoPathStuckRecoveryAt = Date.now()
      log('[stuck] path result', st, '→ recovery')
    }
  }

  function resetNoPathRecoveryBackoff () {
    state.lastNoPathStuckRecoveryAt = 0
  }

  function syncPathfinderDigFlags() {
    if (!movement) return
    if (!config.pathAllowDigNatural) {
      movement.canDig = false
      movement.digCost = 1.8
      return
    }
    if (config.pathDigPreferWalk) {
      movement.canDig = pathfinderDigUnlocked
      movement.digCost = pathfinderDigUnlocked ? config.pathDigNaturalCost : 1.8
    } else {
      movement.canDig = true
      movement.digCost = config.pathDigNaturalCost
    }
  }

  function setPathfinderDigEnabled(unlocked) {
    if (!config.pathDigPreferWalk || !movement) return
    const next = !!unlocked
    if (pathfinderDigUnlocked === next) return
    pathfinderDigUnlocked = next
    syncPathfinderDigFlags()
  }

  function resetPathfinderDigPolicy() {
    pathfinderDigUnlocked = false
    syncPathfinderDigFlags()
  }

  function setMcData(version) {
    mcData = minecraftData(version || bot.version)
    return mcData
  }

  function setupMovements() {
    if (!mcData) mcData = minecraftData(bot.version)
    movement = new NavMovements(bot, { cardinalOnly: config.pathCardinalOnly })

    movement.allowParkour = true
    movement.allow1by1towers = true
    movement.allowFreeMotion = !!config.pathAllowFreeMotion
    movement.allowSprinting = true
    // Not in mineflayer-pathfinder 2.4.x typings; harmless if ignored, used by some forks/newer builds.
    movement.allowSprintingInsideFluid = true
    movement.maxDropDown = 10
    movement.placeCost = 2.5

    if (config.pathAllowDigNatural) {
      applyNaturalDigBlacklist(movement, mcData)
    }
    pathfinderDigUnlocked = false
    syncPathfinderDigFlags()

    const protectedBlocks = ['chest', 'trapped_chest', 'furnace', 'crafting_table', 'ender_chest', 'barrel', 'anvil']
    for (const name of protectedBlocks) {
      const b = mcData.blocksByName[name]
      if (b) movement.blocksCantBreak.add(b.id)
    }

    const padCost = Number(config.pathWallPaddingCost)
    if (padCost > 0 && movement.exclusionAreasStep && typeof movement.exclusionAreasStep.push === 'function') {
      const padCap = Number(config.pathWallPaddingCap) || 2.9
      movement.exclusionAreasStep.push(function pathInsetWallPenalty(block) {
        if (!block?.position || !bot.blockAt) return 0
        const fp =
          typeof block.position.floored === 'function' ? block.position.floored() : block.position
        const px = Math.floor(fp.x)
        const py = Math.floor(fp.y)
        const pz = Math.floor(fp.z)
        let w = 0
        const solid = (dx, dy, dz) => {
          const nb = bot.blockAt(new Vec3(px + dx, py + dy, pz + dz), false)
          return nb?.boundingBox === 'block'
        }
        if (solid(1, 0, 0)) w += padCost
        if (solid(-1, 0, 0)) w += padCost
        if (solid(0, 0, 1)) w += padCost
        if (solid(0, 0, -1)) w += padCost
        const head = padCost * 0.42
        if (solid(1, 1, 0)) w += head
        if (solid(-1, 1, 0)) w += head
        if (solid(0, 1, 1)) w += head
        if (solid(0, 1, -1)) w += head
        return Math.min(w, padCap)
      })
    }

    bot.pathfinder.setMovements(movement)
    if (config.debugMovement) {
      log('[movement]', 'setupMovements', {
        canDig: movement.canDig,
        digCost: movement.digCost,
        allowParkour: movement.allowParkour,
        allow1by1towers: movement.allow1by1towers,
        maxDropDown: movement.maxDropDown,
        pathCardinalOnly: movement.navCardinalOnly,
        pathAllowDigNatural: config.pathAllowDigNatural
      })
    }
  }

  function refreshComeGoal() {
    const entity = getPlayerEntity(state.targetUsername)
    if (!entity) return
    const p = entity.position
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, config.comeNearDistance))
  }

  /** Точки впереди и сбоку + тело — чтобы вытащить из «шарика» листвы. */
  function collectBarrierCandidateBlocks() {
    const ent = bot.entity
    if (!ent) return []
    const base = ent.position
    const yaw = ent.yaw
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    const lx = -fz
    const lz = fx
    const seen = new Set()
    const list = []
    const forwards = [0.32, 0.48, 0.64, 0.8, 0.96, 1.1]
    const lateral = [-0.45, -0.22, 0, 0.22, 0.45]
    const dys = [-0.12, 0.22, 0.45, 0.72, 1.05, 1.38]

    for (let fi = 0; fi < forwards.length; fi++) {
      const f = forwards[fi]
      for (let li = 0; li < lateral.length; li++) {
        const lat = lateral[li]
        for (let di = 0; di < dys.length; di++) {
          const dy = dys[di]
          const pos = base.offset(fx * f + lx * lat, dy, fz * f + lz * lat)
          const b = bot.blockAt(pos)
          if (!b || b.name === 'air' || b.name === 'water' || !b.diggable) continue
          const key = `${b.position.x},${b.position.y},${b.position.z}`
          if (seen.has(key)) continue
          seen.add(key)
          list.push(b)
        }
      }
    }

    const inside = bot.blockAt(base.offset(0, 0.25, 0))
    if (inside && inside.name !== 'air' && inside.diggable) {
      const key = `${inside.position.x},${inside.position.y},${inside.position.z}`
      if (!seen.has(key)) {
        seen.add(key)
        list.unshift(inside)
      }
    }

    const front = getFrontBlock()
    if (front?.chestBlock) list.push(front.chestBlock)
    if (front?.feetBlock) list.push(front.feetBlock)

    return list
  }

  function horizontalSpeed() {
    const vx = bot.entity?.velocity?.x ?? 0
    const vz = bot.entity?.velocity?.z ?? 0
    return Math.sqrt(vx * vx + vz * vz)
  }

  function pathfinderIsMoving() {
    return typeof bot.pathfinder?.isMoving === 'function' && bot.pathfinder.isMoving()
  }

  /** @returns {import('../navigation/AntiStuck').AntiStuckCtx} */
  function buildAntiStuckCtx () {
    return {
      bot,
      config,
      state,
      log,
      getFrontBlock,
      getFeetBlock,
      getPlayerEntity,
      interruptPathfinder,
      handleStuckRecovery,
      tryMineBarrierAhead,
      pathfinderIsMoving,
      horizontalSpeed
    }
  }

  function clearWalkControls() {
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    bot.setControlState('sprint', false)
  }

  /**
   * Сдвиг от выпуклого угла — делегат `navigation/AntiStuck.js` (логика без изменений).
   * @param {number|undefined|null} sidestepMsOpt
   */
  function applyCornerSidestepThen (done, sidestepMsOpt) {
    AntiStuck.applyCornerSidestepThen(buildAntiStuckCtx(), done, sidestepMsOpt)
  }

  /** Угол / edge stall — делегат `navigation/AntiStuck.js`. */
  function tickPathStallEscape () {
    AntiStuck.tickPathStallEscape(buildAntiStuckCtx())
  }

  /**
   * Цель заметно ниже (игрок у ствола, бот в кроне): не долбить листву, а смотреть вниз и дать короткий шаг + repath.
   * Частые вызовы tryMineBarrierAhead + bot.dig отменяют предыдущую копку (stopDigging) — листва никогда не ломается.
   */
  function tryDescendFromCanopy(targetEnt) {
    if (!targetEnt || !bot.entity) return false
    if (targetEnt.position.y >= bot.entity.position.y - 1.05) return false
    if (Date.now() - lastCanopyDescendAt < 2200) return false
    lastCanopyDescendAt = Date.now()

    interruptPathfinder()
    state.repathCooldownTicks = 0
    state.isRecovering = false
    state.recoverUntil = 0

    const t = targetEnt.position
    const p = bot.entity.position
    const yaw = Math.atan2(t.x - p.x, t.z - p.z)
    bot.look(yaw, -0.88, true).catch(() => {})
    bot.setControlState('forward', true)
    setTimeout(() => {
      bot.setControlState('forward', false)
      if (state.mode === 'follow' || state.mode === 'guard') repathToTarget(true)
      else if (state.mode === 'come') refreshComeGoal()
    }, 450)
    log('[recovery] goal below target, attempting descent')
    return true
  }

  /** Ручная копка препятствия (одна попытка за раз, с учётом obstacle state). */
  function tryMineBarrierAhead() {
    if (!config.pathMineBarrierWhenStuck || !bot.entity) return false
    if (Date.now() < state.obstacleRecoveryUntil) return false
    // Повторный bot.dig() отменяет текущую копку — прогресс срывается.
    if (bot.targetDigBlock) return false

    const velY = bot.entity.velocity?.y ?? 0
    const calmVertical = Math.abs(velY) < 0.07
    const hungInFoliage = !bot.entity.onGround && calmVertical
    const hMax = config.stuckCornerVelocityMax ?? 0.048
    const pathActive = pathfinderIsMoving()
    const cornerLike = pathActive && horizontalSpeed() < hMax
    if (!bot.entity.isCollidedHorizontally && !hungInFoliage && !cornerLike) return false

    const targetFollow =
      state.mode === 'follow' || state.mode === 'guard' ? getPlayerEntity(state.targetUsername) : null
    const targetBelow = !!(targetFollow && targetFollow.position.y < bot.entity.position.y - 1.15)
    if (targetBelow && tryDescendFromCanopy(targetFollow)) return true

    const candidates = collectBarrierCandidateBlocks()
    let block = null
    let bestPr = -1
    let bestDist = 1e9
    const here = bot.entity.position
    for (let i = 0; i < candidates.length; i++) {
      const b = candidates[i]
      if (!b || b.name === 'air' || b.name === 'water' || !b.diggable) continue
      if (targetBelow && /_leaves$/i.test(b.name)) continue
      const pr = barrierBreakPriority(b.name)
      if (pr <= 0) continue
      const cx = b.position.x + 0.5
      const cy = b.position.y + 0.5
      const cz = b.position.z + 0.5
      const dist = Math.sqrt((cx - here.x) ** 2 + (cy - here.y) ** 2 + (cz - here.z) ** 2)
      if (pr > bestPr || (pr === bestPr && dist < bestDist)) {
        bestPr = pr
        bestDist = dist
        block = b
      }
    }
    if (!block || bestPr <= 0) {
      if (targetBelow && targetFollow && tryDescendFromCanopy(targetFollow)) return true
      return false
    }

    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) return false

    if (!shouldRetryObstacle(block.position, block.name)) {
      log('[stuck] obstacle repeated, forcing repath')
      const now = Date.now()
      if (now - state.lastObstacleForcedRepathAt > 1600 && handleStuckRecovery('obstacle_repeat')) {
        state.lastObstacleForcedRepathAt = now
      }
      return false
    }

    registerObstacle(block.name, block.position)

    interruptPathfinder()
    state.isRecovering = true
    state.recoverUntil = Date.now() + 1600
    state.repathCooldownTicks = Math.max(state.repathCooldownTicks, 12)

    log('[recovery] dig attempt', block.name)

    bot
      .dig(block, true, 'raycast')
      .then(() => {
        state.obstacleConsecutiveDigFails = 0
        resetObstacleRecovery()
        state.isRecovering = false
        if (state.mode === 'follow' || state.mode === 'guard') repathToTarget(true)
        else if (state.mode === 'come') refreshComeGoal()
      })
      .catch(() => {
        state.obstacleConsecutiveDigFails += 1
        const sig = obstacleBlockSignature(block.position, block.name)
        if (state.obstacleConsecutiveDigFails >= 2) {
          state.obstacleBlockedSig = sig
          state.obstacleBlockedUntil = Date.now() + OBSTACLE_DIG_FAIL_BLOCK_MS
          log('[stuck] no progress, blocking retry')
        }
        state.isRecovering = false
        if (state.mode === 'follow' || state.mode === 'guard') repathToTarget(true)
        else if (state.mode === 'come') refreshComeGoal()
      })
    return true
  }

  function refreshScaffoldingBlocks() {
    if (!movement || !mcData || !bot) return
    const protectedNames = new Set(['chest', 'trapped_chest', 'furnace', 'crafting_table', 'ender_chest', 'barrel', 'anvil'])
    const bucket = movement.scafoldingBlocks
    if (!bucket) return

    if (typeof bucket.clear === 'function') bucket.clear()
    else if (Array.isArray(bucket)) bucket.length = 0
    else movement.scafoldingBlocks = []

    for (const item of bot.inventory.items()) {
      const name = item.name
      const block = mcData.blocksByName[name]
      if (!block || protectedNames.has(name)) continue
      if (name.includes('slab') || name.includes('stairs') || name.includes('wall')) continue
      if (name.includes('glass_pane') || name.includes('fence') || name.includes('door')) continue
      if (typeof movement.scafoldingBlocks.add === 'function') movement.scafoldingBlocks.add(block.id)
      else if (Array.isArray(movement.scafoldingBlocks)) movement.scafoldingBlocks.push(block.id)
    }
  }

  function setModeIdle() {
    state.navFollowViaBus = false
    state.mode = 'idle'
    state.targetUsername = null
    interruptPathfinder()
    resetStuckState(bot)
    resetPathfinderDigPolicy()
    log('Mode -> IDLE')
  }

  function setModeFollow(username) {
    state.mode = 'follow'
    state.targetUsername = username
    state.lastRepathTick = 0
    if (movement) movement.allowParkour = true
    resetStuckState(bot)
    resetPathfinderDigPolicy()
    interruptPathfinder()
    if (!state.navFollowViaBus) repathToTarget(true)
    log('Mode -> FOLLOW', username)
  }

  function setModeCome(username) {
    state.navFollowViaBus = false
    state.mode = 'come'
    state.targetUsername = username
    resetStuckState(bot)
    resetPathfinderDigPolicy()
    const entity = getPlayerEntity(username)
    if (!entity) return
    const p = entity.position
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, config.comeNearDistance))
    log('Mode -> COME', username)
  }

  /**
   * Креатив-полёт (mineflayer `bot.creative`: обнуляет gravity). Нужен gamemode `creative` на сервере.
   * Для /fly в survival см. FLY_ALLOW_NON_CREATIVE в config.
   */
  function toggleFlight(enable) {
    const want = !!enable
    if (!bot.creative || typeof bot.creative.startFlying !== 'function' || typeof bot.creative.stopFlying !== 'function') {
      return 'Нет bot.creative (плагин mineflayer не подключён).'
    }
    const gm = bot.game?.gameMode
    const allowNonCreative = !!config.flyAllowNonCreative
    if (want && gm !== 'creative' && !allowNonCreative) {
      const gms = gm == null || gm === '' ? '?' : String(gm)
      return `Сейчас gamemode=${gms}, для полёта нужен creative (или FLY_ALLOW_NON_CREATIVE=1 в .env).`
    }
    if (want && (state.mode === 'follow' || state.mode === 'guard' || state.mode === 'come')) {
      interruptPathfinder()
      state.repathCooldownTicks = 0
      state.pathStallTicks = 0
      state.lastPathProgressPos = bot.entity?.position?.clone?.() || null
      // Иначе repathToTarget(false) на тиках не выставит цель, пока игрок не отойдёт (shouldRepathTarget).
      if (state.mode === 'follow' || state.mode === 'guard') repathToTarget(true)
      else if (state.mode === 'come') refreshComeGoal()
    }
    try {
      if (want) bot.creative.startFlying()
      else bot.creative.stopFlying()
    } catch (e) {
      return `Ошибка полёта: ${e.message}`
    }
    log(want ? 'Flight -> ON' : 'Flight -> OFF')
    return want ? 'Полёт включён (креатив-физика).' : 'Полёт выключен, гравитация восстановлена.'
  }

  /** Разовый pathfinder к точке (Assistant tool moveTo и т.п.). */
  async function gotoNearCoords(x, y, z, range = 2) {
    const gx = Number(x)
    const gy = Number(y)
    const gz = Number(z)
    if (![gx, gy, gz].every(Number.isFinite)) {
      throw new Error('Некорректные координаты')
    }
    const r = Number.isFinite(Number(range)) ? Number(range) : 2
    setModeIdle()
    if (!bot.pathfinder?.goto) throw new Error('pathfinder.goto недоступен')
    await bot.pathfinder.goto(new goals.GoalNear(gx, gy, gz, r))
  }

  function shouldRepathTarget(targetEntity, dist) {
    const tickSinceRepath = state.tickCounter - state.lastRepathTick
    if (tickSinceRepath < config.followRefreshTicks) return false
    if (!bot.entity || !targetEntity) return false
    const distance = bot.entity.position.distanceTo(targetEntity.position)
    return distance > dist + config.minFollowRepathDistance
  }

  function repathToTarget(force = false) {
    if (!(state.mode === 'follow' || state.mode === 'guard')) return
    if (state.navFollowViaBus && !force) return
    if (state.isRecovering && Date.now() < state.recoverUntil) return
    if (!force && state.repathCooldownTicks > 0) return
    const targetEntity = getPlayerEntity(state.targetUsername)
    if (!targetEntity) return

    const dist = state.mode === 'guard' ? config.guardFollowDistance : config.followDistance
    if (!force && !shouldRepathTarget(targetEntity, dist)) return
    bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, dist), true)
    state.lastRepathTick = state.tickCounter
  }

  function getPathfinderGoalVec3() {
    const g = bot.pathfinder?.goal
    if (!g || !bot.entity) return null
    if (g.entity?.position) return g.entity.position.clone()
    if (Number.isFinite(g.x) && Number.isFinite(g.z)) {
      const y = Number.isFinite(g.y) ? g.y + 0.5 : bot.entity.position.y
      return new Vec3(g.x + 0.5, y, g.z + 0.5)
    }
    return null
  }

  /**
   * «Прилипание»: зажаты WASD, почти нет XZ-скорости, луч по намерению движения бьёт в блок ближе ~0.3 блока.
   * Пауза pathfinder → back+jump; если дольше ~1 с — разворот yaw+π и спринт вперёд.
   */
  function tickWallStickEscape(now, nowP, pf) {
    if (!config.wallStickBounceEnabled || !bot.entity || !pf) return false

    let phase = state.wallStickPhase || 'idle'

    if (phase === 'backjump') {
      if (nowP < state.wallStickBackJumpEndPerf) {
        state.wallStickManualDrive = true
        bot.setControlState('forward', false)
        bot.setControlState('left', false)
        bot.setControlState('right', false)
        bot.setControlState('back', true)
        bot.setControlState('jump', !!bot.entity.onGround)
        bot.setControlState('sprint', false)
        return true
      }
      bot.setControlState('back', false)
      bot.setControlState('jump', false)
      state.wallStickPhase = 'wait_pf'
      phase = 'wait_pf'
    }

    if (phase === 'wait_pf') {
      if (nowP < state.wallStickPfPauseUntilPerf) {
        state.wallStickManualDrive = true
        return true
      }
      state.wallStickPhase = 'idle'
      state.wallStickManualDrive = false
      state.wallStickSincePerf = 0
      phase = 'idle'
    }

    if (phase === 'turn_sprint') {
      if (nowP < state.wallStickPfPauseUntilPerf) {
        state.wallStickManualDrive = true
        if (nowP < state.wallStickSprintDriveEndPerf) {
          bot.setControlState('forward', true)
          bot.setControlState('back', false)
          bot.setControlState('left', false)
          bot.setControlState('right', false)
          bot.setControlState('jump', false)
          bot.setControlState('sprint', true)
        } else {
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
        }
        return true
      }
      state.wallStickPhase = 'idle'
      state.wallStickManualDrive = false
      state.wallStickSincePerf = 0
      state.wallStickLastSprintEscapeAt = now
      phase = 'idle'
    }

    if (phase !== 'idle') return false

    const movingGoal = !!(pf.isMoving?.() && pf.goal)
    const navContext =
      movingGoal || state.mode === 'follow' || state.mode === 'guard' || state.mode === 'come'
    if (!navContext || pf.isMining?.()) {
      state.wallStickSincePerf = 0
      return false
    }

    const keys = movementKeysActive(bot)
    const hMax = horizontalSpeed()
    const epsV = Number(config.wallStickVelEps) || 0.02
    const rayMax = Number(config.wallStickRayBlocks) || 0.3
    const collided = !!bot.entity.isCollidedHorizontally
    const intentBlocked = obstacleAlongMoveIntent(bot, rayMax)
    const sticking = keys && hMax < epsV && (collided || intentBlocked)

    if (!sticking) {
      state.wallStickSincePerf = 0
      return false
    }

    if (!state.wallStickSincePerf) state.wallStickSincePerf = nowP

    const armMs = Number(config.wallStickArmMs) || 220
    const sprintAfter = Number(config.wallStickSprintAfterMs) || 1000
    const cdBounce = Number(config.wallStickBounceCooldownMs) || 4200
    const cdSprint = Number(config.wallStickSprintEscapeCooldownMs) || 5500

    if (
      nowP - state.wallStickSincePerf >= sprintAfter &&
      now - (state.wallStickLastSprintEscapeAt || 0) >= cdSprint &&
      typeof pf.pausePathExecution === 'function'
    ) {
      const pauseMs = Number(config.wallStickSprintPfPauseMs) || 440
      const driveMs = Number(config.wallStickSprintDriveMs) || 260
      pf.pausePathExecution(pauseMs)
      const untilPause = nowP + pauseMs
      state.navAssistPathfinderPausePerf = Math.max(state.navAssistPathfinderPausePerf || 0, untilPause)
      state.wallStickPfPauseUntilPerf = untilPause
      state.wallStickSprintDriveEndPerf = nowP + driveMs
      state.wallStickPhase = 'turn_sprint'
      state.wallStickManualDrive = true
      const awayYaw = bot.entity.yaw + Math.PI
      bot.look(awayYaw, bot.entity.pitch, true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('back', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
      bot.setControlState('jump', false)
      bot.setControlState('sprint', true)
      if (config.debugMovement) log('[nav-assist] wall stick sprint-escape (>1s)')
      return true
    }

    if (nowP - state.wallStickSincePerf < armMs) return false
    if (now - (state.wallStickLastBounceAt || 0) < cdBounce) return false

    if (typeof pf.pausePathExecution === 'function') {
      const pfPause = Number(config.wallStickPfPauseMs) || 520
      const backMs = Number(config.wallStickBackJumpMs) || 140
      pf.pausePathExecution(pfPause)
      const untilPf = nowP + pfPause
      state.navAssistPathfinderPausePerf = Math.max(state.navAssistPathfinderPausePerf || 0, untilPf)
      state.wallStickPfPauseUntilPerf = untilPf
      state.wallStickPhase = 'backjump'
      state.wallStickBackJumpEndPerf = nowP + backMs
      state.wallStickManualDrive = true
      state.wallStickLastBounceAt = now
      bot.setControlState('forward', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
      bot.setControlState('back', true)
      bot.setControlState('jump', !!bot.entity.onGround)
      bot.setControlState('sprint', false)
      if (config.debugMovement) log('[nav-assist] wall bounce back+jump')
      return true
    }

    return false
  }

  /**
   * После pathfinder: raycast-jump, velocity-stall jump, срез следующего узла LOS, умный stuck → skip + back + стрейф.
   * Режим idle + goto Near тоже обслуживается, если активен маршрут (ассистент moveTo не ломается).
   */
  function tickNavAssist() {
    if (!bot.entity) return
    const now = Date.now()
    const nowP = performance.now()
    const pf = bot.pathfinder
    const skipApi = pf && typeof pf.skipPathSteps === 'function'

    /** Ручное восстановление после smart stuck — pathfinder паузируется см. pausePathExecution. */
    if (state.navAssistRecoverPhase === 'back') {
      if (nowP < state.navAssistRecoverBackEndPerf) {
        bot.setControlState('forward', false)
        bot.setControlState('left', false)
        bot.setControlState('right', false)
        bot.setControlState('back', true)
        return
      }
      state.navAssistRecoverPhase = 'strafe'
    }
    if (state.navAssistRecoverPhase === 'strafe') {
      if (nowP < state.navAssistRecoverStrafeEndPerf) {
        bot.setControlState('back', false)
        bot.setControlState('forward', true)
        const side = state.navAssistRecoverSide === 'right' ? 'right' : 'left'
        bot.setControlState(side, true)
        /** У угла без headroom прыжок всаживает в блоки — только если не прижаты к стене. */
        const canJump = !bot.entity?.isCollidedHorizontally && hasVerticalHeadroom(bot)
        bot.setControlState('jump', canJump)
        return
      }
      state.navAssistRecoverPhase = ''
      bot.setControlState('back', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
      bot.setControlState('jump', false)
      state.navAssistSmartAnchorPos = bot.entity.position.clone()
      state.navAssistSmartAnchorMs = now
    }

    if (config.wallStickBounceEnabled && tickWallStickEscape(now, nowP, pf)) return
    if (!config.navAssistEnabled) return

    const movingGoal = !!(pf?.isMoving?.() && pf?.goal)
    const controlMove = movementKeysActive(bot)
    /** Пока pathfinder искусственно на паузе — поджимаем вперёд, иначе 50–140 мс без клавиш («замирает»). */
    const pausedByAssist = nowP < (state.navAssistPathfinderPausePerf || 0)
    if (
      movingGoal &&
      pausedByAssist &&
      !state.navAssistRecoverPhase &&
      !state.wallStickManualDrive &&
      !pf?.isMining?.()
    ) {
      bot.setControlState('forward', true)
    }

    /** Ускользание от нуля скорости при зажатых WASD от pathfinder или PvP. Не давим jump во время assist-паузы. */
    const hMax = horizontalSpeed()
    const wallSliding = !!bot.entity.isCollidedHorizontally
    /** Топчемся у стены — прыжок не помогает и провоцирует залипание в hitbox. */
    if (!pausedByAssist && !state.wallStickManualDrive && movementKeysActive(bot) && !wallSliding) {
      if (hMax < config.navAssistVelocityEps) {
        if (!state.navAssistVelocityStallSincePerf) state.navAssistVelocityStallSincePerf = nowP
        if (nowP - state.navAssistVelocityStallSincePerf >= config.navAssistVelocityStallMs) {
          if (hasVerticalHeadroom(bot)) bot.setControlState('jump', true)
        }
      } else {
        state.navAssistVelocityStallSincePerf = 0
      }
    } else {
      state.navAssistVelocityStallSincePerf = 0
    }

    if ((!movingGoal && !controlMove) || pf?.isMining?.()) return

    const goalXZ = getPathfinderGoalVec3()
    if (!goalXZ) return

    /** Обход дерева/угла после pathfinder: стрейф + выключаем «вперёд в ствол» на следующий симуляционный тик. */
    const peelBarrier = Number(config.navAssistPeelBarrierBlocks) || 0.38
    const peelSlowGate = Number(config.navAssistPeelSlowSpeed) || 0.07
    const barrierClose = preemptiveBarrierAhead(bot, peelBarrier, bot.entity.yaw)
    const peelGate =
      movingGoal &&
      !state.navAssistRecoverPhase &&
      !pausedByAssist &&
      !state.wallStickManualDrive &&
      !pf?.isMining?.() &&
      pathfinderIsMoving() &&
      (wallSliding || (barrierClose && hMax < peelSlowGate))
    if (peelGate) {
      bot.setControlState('left', false)
      bot.setControlState('right', false)
      const probe = Number(config.navAssistCollideProbeBlocks) || 0.92
      const side = pickLateralEscapeSide(bot, goalXZ, probe)
      if (side) {
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        bot.setControlState(side, true)
        bot.setControlState('jump', false)
        if (config.debugMovement)
          log('[nav-assist] wall peel', side, wallSliding ? 'collide' : 'barrier-close')
      }
    }

    if (movingGoal && skipApi && !state.navAssistRecoverPhase) {
      if (nowP - (state.navAssistCornerCutPerf || 0) >= config.navAssistCornerCutCooldownMs) {
        const a = pf.pathStepAt(0)
        const b = pf.pathStepAt(1)
        if (
          a &&
          b &&
          !(a.toBreak?.length > 0) &&
          !(a.toPlace?.length > 0) &&
          Math.abs(a.y - b.y) <= 1.1
        ) {
          const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0)
          const target = new Vec3(b.x, b.y + 0.12, b.z)
          if (losTo(bot, eye, target, 0.42)) {
            pf.skipPathSteps(1)
            state.navAssistCornerCutPerf = nowP
            if (config.debugMovement) log('[nav-assist] corner cut LOS → skip step')
          }
        }
      }
    }

    if (
      movingGoal &&
      skipApi &&
      !state.navAssistRecoverPhase &&
      typeof pf.pausePathExecution === 'function' &&
      now >= state.navAssistRecoverCooldownUntil &&
      pausedByAssist === false
    ) {
      const pos = bot.entity.position
      const xzDist = (p, anchor) =>
        typeof p.xzDistanceTo === 'function'
          ? p.xzDistanceTo(anchor)
          : Math.hypot(p.x - anchor.x, p.z - anchor.z)
      const dGoal = pos.distanceTo(goalXZ)
      const eps = Number(config.navAssistSmartStuckEpsilon) || 0.2
      const winMs = Number(config.navAssistSmartStuckWindowMs) || 2800
      const goalGain = Number(config.navAssistSmartStuckGoalGain) || 0.07
      const slowHold = Number(config.navAssistSmartLowSpeedHoldMs) || 700

      if (!state.navAssistSmartAnchorPos) {
        state.navAssistSmartAnchorPos = pos.clone()
        state.navAssistSmartAnchorMs = now
        state.navAssistGoalDistAnchor = dGoal
      }

      const xzTravel = xzDist(pos, state.navAssistSmartAnchorPos)

      /** В траве/месиве маленький XZ уже «прогресс». Ближе к цели без шага по XZ — тоже сброс якоря. */
      const closerToGoal =
        state.navAssistGoalDistAnchor != null &&
        Number.isFinite(state.navAssistGoalDistAnchor) &&
        dGoal < state.navAssistGoalDistAnchor - goalGain
      if (xzTravel >= eps || closerToGoal) {
        state.navAssistSmartAnchorPos = pos.clone()
        state.navAssistSmartAnchorMs = now
        state.navAssistGoalDistAnchor = dGoal
        state.navAssistLowSpeedPerf = 0
      } else {
        const grounded = !!bot.entity.onGround
        const slow = grounded && movingGoal && hMax < 0.038
        if (!slow) state.navAssistLowSpeedPerf = 0
        else if (!state.navAssistLowSpeedPerf) state.navAssistLowSpeedPerf = nowP

        const collided = !!bot.entity.isCollidedHorizontally
        const sustainedSlow =
          !!(state.navAssistLowSpeedPerf && nowP - state.navAssistLowSpeedPerf >= slowHold)
        const stuckGate = collided || sustainedSlow

        if (
          stuckGate &&
          now - state.navAssistSmartAnchorMs >= winMs
        ) {
          const pauseMs =
            config.navAssistRecoverBackMs +
            config.navAssistRecoverStrafeMs +
            (Number(config.navAssistRecoverPauseTailMs) || 95)

          pf.skipPathSteps(1)
          pf.pausePathExecution(pauseMs)
          state.navAssistPathfinderPausePerf = nowP + pauseMs

          state.navAssistRecoverSide = pickStrafeSide(bot, goalXZ) || state.navAssistRecoverSide || 'left'
          state.navAssistRecoverBackEndPerf = nowP + config.navAssistRecoverBackMs
          state.navAssistRecoverStrafeEndPerf =
            nowP + config.navAssistRecoverBackMs + config.navAssistRecoverStrafeMs
          state.navAssistRecoverPhase = 'back'

          state.navAssistRecoverCooldownUntil = now + (Number(config.navAssistSmartRecoverCooldownMs) || 5200)

          state.navAssistSmartAnchorPos = pos.clone()
          state.navAssistSmartAnchorMs = now
          state.navAssistGoalDistAnchor = dGoal
          state.navAssistLowSpeedPerf = 0

          const shouldLog =
            config.debugMovement || now - (state.navAssistLastSmartStuckLogAt || 0) > 20000
          if (shouldLog) {
            state.navAssistLastSmartStuckLogAt = now
            log(
              '[nav-assist] smart stuck → skip/back/strafe' +
              (collided ? ' [hit]' : ' [slow-speed]')
            )
          }
          return
        }
      }
    }

    if (bot.entity.isInWater) return

    const rayDist = Number(config.navAssistRayDistance) || 1.2
    const yawLook = bot.entity.yaw // pathfinder задаёт yaw к следующей точке на том же тике раньше
    if (
      pathfinderIsMoving() &&
      bot.entity.onGround &&
      !bot.entity.isCollidedHorizontally &&
      hasVerticalHeadroom(bot) &&
      preemptiveBarrierAhead(bot, rayDist, yawLook)
    ) {
      bot.setControlState('jump', true)
    }
  }

  /** Anti-stuck / corner — делегат `navigation/AntiStuck.js`. */
  function handleAntiStuck () {
    AntiStuck.handleAntiStuck(buildAntiStuckCtx())
  }

  return {
    setMcData,
    setupMovements,
    refreshScaffoldingBlocks,
    setModeIdle,
    setModeFollow,
    setModeCome,
    gotoNearCoords,
    toggleFlight,
    repathToTarget,
    handleAntiStuck,
    tickPathStallEscape,
    refreshComeGoal,
    setPathfinderDigEnabled,
    resetPathfinderDigPolicy,
    recordNavProgress,
    onPathfinderUpdate,
    handleStuckRecovery,
    resetNoPathRecoveryBackoff,
    resetObstacleRecovery,
    tickNavAssist
  }
}
