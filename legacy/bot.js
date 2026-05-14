const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin
const { loader: autoJump } = require('@nxg-org/mineflayer-auto-jump')
const { loader: baritoneLoader, goals: baritoneGoals } = require('@miner-org/mineflayer-baritone')
const minecraftData = require('minecraft-data')
const { Vec3 } = require('vec3')

// ---------- Config ----------
const CONFIG = {
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || 'MINI_KOSH',
  version: process.env.MC_VERSION || '1.21.11',
  auth: process.env.MC_AUTH || 'offline',

  // Comma-separated list in .env: ALLOWED_USERS=Steve,Alex
  allowedUsers: (process.env.ALLOWED_USERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ВАЖНО: не храни ключ в коде
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
  nvidiaModel: process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct',

  aiCooldownMs: Number(process.env.AI_COOLDOWN_MS || 4000),
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 12000),

  guardScanIntervalTicks: Number(process.env.GUARD_SCAN_TICKS || 8),
  guardFollowDistance: Number(process.env.GUARD_FOLLOW_DISTANCE || 3),
followDistance: Number(process.env.FOLLOW_DISTANCE || 3),
  comeNearDistance: Number(process.env.COME_NEAR_DISTANCE || 1),
  guardMobDistance: Number(process.env.GUARD_MOB_DISTANCE || 10),

  // Анти-тупняк pathfinder
  followRefreshTicks: Number(process.env.FOLLOW_REFRESH_TICKS || 10), // чаще обновляем цель
  minFollowRepathDistance: Number(process.env.MIN_FOLLOW_REPATH_DISTANCE || 2.5),
  stuckCheckTicks: Number(process.env.STUCK_CHECK_TICKS || 30), // 1 сек (20 tps)
  stuckMoveThreshold: Number(process.env.STUCK_MOVE_THRESHOLD || 0.15), // увеличен порог для надёжного детекта
  maxStuckCountBeforeNudge: Number(process.env.MAX_STUCK_BEFORE_NUDGE || 2),
  loopGuardTicks: Number(process.env.LOOP_GUARD_TICKS || 12),
  loopMoveThreshold: Number(process.env.LOOP_MOVE_THRESHOLD || 0.02),
  debugMovement: process.env.DEBUG_MOVEMENT === '1',
useBaritoneFollow: false,

  reconnectMaxDelayMs: Number(process.env.RECONNECT_MAX_DELAY_MS || 30000)
}

// ---------- Runtime State ----------
const state = {
  mode: 'idle', // idle | follow | guard | come
  targetUsername: null,
  tickCounter: 0,
  lastAiReplyAt: 0,
  reconnectAttempts: 0,
  reconnectTimer: null,
  autonomousTimer: null,
  lastAutonomousAction: 0,

  // follow/guard repath control
  lastRepathTick: 0,

  // anti-stuck
  lastStuckPos: null,
  stuckCount: 0,
  isRecovering: false,
  recoverUntil: 0,
  loopTicks: 0,
  jumpHoldTicks: 0,
  forwardHoldTicks: 0,
  backHoldTicks: 0,
  leftHoldTicks: 0,
  rightHoldTicks: 0,
  repathCooldownTicks: 0,
  lastBaritoneGoalTick: 0,
  baritoneInFlight: false
}

let bot = null
let mcData = null
let movement = null

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args)
}

function debugLog(hypothesisId, location, message, data = {}, runId = 'baseline') {
  // #region agent log
  fetch('http://127.0.0.1:7613/ingest/3296d502-6143-4d02-8219-a018e8e8c795', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '35eadf'
    },
    body: JSON.stringify({
      sessionId: '35eadf',
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now()
    })
  }).catch(() => {})
  // #endregion
}

function isAllowedUser(username) {
  if (CONFIG.allowedUsers.length === 0) return true
  return CONFIG.allowedUsers.includes(username)
}

function safeChat(text) {
  if (!bot) return
  const maxLen = 240
  const msg = String(text || '').slice(0, maxLen)
  if (msg.length > 0) bot.chat(msg)
}

function getPlayerEntity(username) {
  if (!bot || !username) return null
  return bot.players[username]?.entity || null
}

function resetStuckState() {
  state.lastStuckPos = bot?.entity?.position?.clone?.() || null
  state.stuckCount = 0
}

function setModeIdle() {
  state.mode = 'idle'
  state.targetUsername = null
  if (bot?.pathfinder) bot.pathfinder.setGoal(null)
  if (bot?.ashfinder) bot.ashfinder.stop()
  if (bot?.pvp) bot.pvp.stop()
  resetStuckState()
  log('Mode -> IDLE')
}

function setModeFollow(username) {
  state.mode = 'follow'
  state.targetUsername = username
  state.lastRepathTick = 0
if (movement) movement.allowParkour = true
  if (bot?.autoJump) bot.autoJump.enable()
  // #region agent log
  debugLog('H1', 'bot.js:setModeFollow', 'follow mode configured', {
    allowParkour: movement?.allowParkour,
    allow1by1towers: movement?.allow1by1towers
  })
  // #endregion
  resetStuckState()
  if (bot?.pathfinder) bot.pathfinder.setGoal(null)
  repathToTarget(true)
  log('Mode -> FOLLOW', username)
}

function setModeGuard(username) {
  state.mode = 'guard'
  state.targetUsername = username
  state.lastRepathTick = 0
if (movement) movement.allowParkour = false
  if (bot?.autoJump) bot.autoJump.enable()
  resetStuckState()
  repathToTarget(true)
  log('Mode -> GUARD', username)
}

function setModeCome(username) {
  state.mode = 'come'
  state.targetUsername = username
  resetStuckState()
  const entity = getPlayerEntity(username)
  if (!entity) return
  const p = entity.position
  if (bot?.autoJump) bot.autoJump.enable()
  bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, CONFIG.comeNearDistance))
  log('Mode -> COME', username)
}

function setupMovements() {
  // mineflayer-pathfinder сильно лучше работает с явным minecraft-data
  movement = new Movements(bot, mcData)

  // Основные параметры движения
  movement.canDig = false
  movement.allowParkour = true
  movement.allow1by1towers = true
  movement.allowSprinting = true
  movement.maxDropDown = 10
  movement.digCost = 1.8
  movement.placeCost = 2.5

  // Не ломать явно полезные блоки
  const protectedBlocks = ['chest', 'trapped_chest', 'furnace', 'crafting_table', 'ender_chest', 'barrel', 'anvil']
  for (const name of protectedBlocks) {
    const b = mcData.blocksByName[name]
    if (b) movement.blocksCantBreak.add(b.id)
  }

  bot.pathfinder.setMovements(movement)
  // #region agent log
  debugLog('H1', 'bot.js:setupMovements', 'movement profile applied', {
    canDig: movement.canDig,
    allowParkour: movement.allowParkour,
    allow1by1towers: movement.allow1by1towers,
    maxDropDown: movement.maxDropDown,
    digCost: movement.digCost,
    placeCost: movement.placeCost
  })
  // #endregion
}

function getFeetBlock() {
  if (!bot?.entity) return null
  return bot.blockAt(bot.entity.position.offset(0, -0.1, 0))
}

function getFrontBlock() {
  if (!bot?.entity) return null
  const yaw = bot.entity.yaw
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  const ahead = bot.entity.position.offset(fx * 0.9, 0, fz * 0.9)
  const chestBlock = bot.blockAt(ahead.offset(0, 0.5, 0))
  const feetBlock = bot.blockAt(ahead.offset(0, -0.5, 0))
  return { chestBlock, feetBlock }
}

function logStuckContext(reason) {
  const feet = getFeetBlock()
  const front = getFrontBlock()
  log('[stuck-debug]', reason, {
    mode: state.mode,
    onGround: !!bot?.entity?.onGround,
    collidedHorizontally: !!bot?.entity?.isCollidedHorizontally,
    velY: bot?.entity?.velocity?.y,
    feetBlock: feet?.name || null,
    frontFeetBlock: front?.feetBlock?.name || null,
    frontChestBlock: front?.chestBlock?.name || null
  })
}

function refreshScaffoldingBlocks() {
  if (!movement || !mcData || !bot) return
  const protectedNames = new Set([
    'chest', 'trapped_chest', 'furnace', 'crafting_table', 'ender_chest', 'barrel', 'anvil'
  ])
  const bucket = movement.scafoldingBlocks
  if (!bucket) {
    // #region agent log
    debugLog('H6', 'bot.js:refreshScaffoldingBlocks', 'scafoldingBlocks missing', {}, 'post-fix')
    // #endregion
    return
  }
  if (typeof bucket.clear === 'function') {
    bucket.clear()
  } else if (Array.isArray(bucket)) {
    bucket.length = 0
  } else {
    movement.scafoldingBlocks = []
  }
  const inventoryItems = bot.inventory.items()
  const selectedNames = []
  for (const item of inventoryItems) {
    const name = item.name
    const block = mcData.blocksByName[name]
    if (!block) continue
    if (protectedNames.has(name)) continue
    // Avoid using fragile or problematic blocks as scaffolding
    if (name.includes('slab') || name.includes('stairs') || name.includes('wall')) continue
    if (name.includes('glass_pane') || name.includes('fence') || name.includes('door')) continue
    if (typeof movement.scafoldingBlocks.add === 'function') {
      movement.scafoldingBlocks.add(block.id)
    } else if (Array.isArray(movement.scafoldingBlocks)) {
      movement.scafoldingBlocks.push(block.id)
    }
    selectedNames.push(name)
  }
  // #region agent log
  debugLog('H3', 'bot.js:refreshScaffoldingBlocks', 'scaffolding inventory refreshed', {
    count: typeof movement.scafoldingBlocks.size === 'number'
      ? movement.scafoldingBlocks.size
      : movement.scafoldingBlocks.length,
    inventoryBlockNames: inventoryItems.map((it) => it.name).slice(0, 20),
    selectedScaffoldNames: selectedNames.slice(0, 20)
  }, 'post-fix')
  // #endregion
}

function handleSpawn() {
  log('Bot spawned successfully')
  mcData = minecraftData(bot.version)
  setupMovements()
  refreshScaffoldingBlocks()
  resetStuckState()
  if (bot?.autoJump) {
    bot.autoJump.enable()
    log('autoJump enabled')
  }
  startAutonomousLoop()
}

function shouldRepathTarget(targetEntity, dist) {
  const tickSinceRepath = state.tickCounter - state.lastRepathTick
  if (tickSinceRepath < CONFIG.followRefreshTicks) return false
  if (!bot.entity || !targetEntity) return false

  const distance = bot.entity.position.distanceTo(targetEntity.position)
  if (distance <= dist + CONFIG.minFollowRepathDistance) return false
  return true
}

function canUseBaritoneFollow() {
return false

}

function tickBaritoneFollow() {
  if (!canUseBaritoneFollow()) return
  if (state.baritoneInFlight) return
  if (state.tickCounter - state.lastBaritoneGoalTick < 12) return
  const targetEntity = getPlayerEntity(state.targetUsername)
  if (!targetEntity) return

  state.lastBaritoneGoalTick = state.tickCounter
  state.baritoneInFlight = true
  const goal = new baritoneGoals.GoalNear(new Vec3(targetEntity.position.x, targetEntity.position.y, targetEntity.position.z), CONFIG.followDistance + 1)
  // #region agent log
  debugLog('H9', 'bot.js:tickBaritoneFollow', 'baritone goto start', {
    targetUsername: state.targetUsername,
    targetY: targetEntity.position.y,
    botY: bot.entity?.position?.y
  }, 'post-fix')
  // #endregion
  bot.ashfinder.goto(goal)
    .then(() => {
      // #region agent log
      debugLog('H9', 'bot.js:tickBaritoneFollow', 'baritone goto resolved', {}, 'post-fix')
      // #endregion
    })
    .catch((err) => {
      // #region agent log
      debugLog('H9', 'bot.js:tickBaritoneFollow', 'baritone goto rejected', {
        error: err?.message || String(err)
      }, 'post-fix')
      // #endregion
    })
    .finally(() => {
      state.baritoneInFlight = false
    })
}

function repathToTarget(force = false) {
  if (!(state.mode === 'follow' || state.mode === 'guard')) return
  if (state.mode === 'follow' && canUseBaritoneFollow()) return
  if (state.isRecovering && Date.now() < state.recoverUntil) return
  if (!force && state.repathCooldownTicks > 0) return
  const targetEntity = getPlayerEntity(state.targetUsername)
  if (!targetEntity) return

  const dist = state.mode === 'guard' ? CONFIG.guardFollowDistance : CONFIG.followDistance
  if (!force && !shouldRepathTarget(targetEntity, dist)) return

  bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, dist), true)
  // #region agent log
  debugLog('H4', 'bot.js:repathToTarget', 'goal follow set', {
    mode: state.mode,
    force,
    dist,
    targetUsername: state.targetUsername,
    targetY: targetEntity.position?.y,
    botY: bot.entity?.position?.y
  })
  // #endregion
  state.lastRepathTick = state.tickCounter
}

function handleAntiStuck() {
  if (!(state.mode === 'follow' || state.mode === 'guard' || state.mode === 'come')) return
  if (state.tickCounter % CONFIG.stuckCheckTicks !== 0) return
  if (!bot.entity) return

  // Если recovery окно прошло — выключаем флаг
  if (state.isRecovering && Date.now() >= state.recoverUntil) {
    state.isRecovering = false
  }

  if (!state.lastStuckPos) {
    state.lastStuckPos = bot.entity.position.clone()
    return
  }

  const moved = bot.entity.position.distanceTo(state.lastStuckPos)
  state.lastStuckPos = bot.entity.position.clone()

  const effectiveThreshold = CONFIG.stuckMoveThreshold  // не ограничиваем принудительно
  const collided = !!bot.entity?.isCollidedHorizontally
  const isStuck = moved < effectiveThreshold && (collided || !bot.entity?.onGround && bot.entity?.velocity?.y === 0)
  if (isStuck) {
    const front = getFrontBlock() || {}
    const frontChestName = front.chestBlock?.name || 'air'
    const frontFeetName = front.feetBlock?.name || 'air'
    const feetName = getFeetBlock()?.name || 'air'
    // 1-block step: block at feet level ahead, free head space ahead.
    const isStepObstacle = frontFeetName !== 'air' && frontChestName === 'air'
    const isWallObstacle = frontChestName !== 'air'
    const onGround = !!bot.entity?.onGround
    state.stuckCount += 1
    log('Stuck suspected. Count:', state.stuckCount, 'mode:', state.mode)
    // #region agent log
    debugLog('H2', 'bot.js:handleAntiStuck', 'stuck detected', {
      mode: state.mode,
      moved,
      threshold: effectiveThreshold,
      stuckCount: state.stuckCount,
      onGround: bot.entity?.onGround,
      isCollidedHorizontally: bot.entity?.isCollidedHorizontally,
      velY: bot.entity?.velocity?.y,
      frontChestBlock: frontChestName,
      frontFeetBlock: frontFeetName,
      feetBlock: feetName
    })
    // #endregion

    if (CONFIG.debugMovement) {
      logStuckContext('detected')
    }

    // Шаг 1: controlled jump over 1-block obstacle
    if (state.stuckCount === 1) {
      state.isRecovering = true
      state.recoverUntil = Date.now() + 800
      state.repathCooldownTicks = 10
      state.forwardHoldTicks = 8

      const autoJumpCanJump = typeof bot?.autoJump?.canJump === 'function' ? bot.autoJump.canJump() : null
      const autoJumpShouldJump = typeof bot?.autoJump?.shouldJump === 'function' ? bot.autoJump.shouldJump() : null

      // Проверяем блок над уровнем ног впереди (есть ли потолок над ступенькой)
      let frontAboveName = 'air'
      if (bot.entity) {
        const yaw = bot.entity.yaw
        const fx = -Math.sin(yaw)
        const fz = -Math.cos(yaw)
        const ahead = bot.entity.position.offset(fx * 0.9, 0, fz * 0.9)
        frontAboveName = bot.blockAt(ahead.offset(0, 1.0, 0))?.name || 'air'
      }

      // 1-блок ступенька: на уровне ног блок есть, на уровне груди — воздух, над блоком — воздух
      const isRealStep = frontFeetName !== 'air' && frontChestName === 'air' && frontAboveName === 'air'

      // Обрыв: впереди воздух на обоих уровнях
      const isEdge = frontFeetName === 'air' && frontChestName === 'air'
      let dropDepth = 0
      if (isEdge && bot.entity) {
        const yaw = bot.entity.yaw
        const fx = -Math.sin(yaw)
        const fz = -Math.cos(yaw)
        const aheadPos = bot.entity.position.offset(fx * 1.2, 0, fz * 1.2)
        for (let dy = 1; dy <= movement.maxDropDown; dy++) {
          const b = bot.blockAt(aheadPos.offset(0, -dy, 0))
          if (b && b.name !== 'air') { dropDepth = dy; break }
        }
      }

      if (isEdge && dropDepth > 0 && dropDepth <= movement.maxDropDown) {
        // Спрыгиваем с обрыва — просто идём вперёд без снизания
        log('[drop-off] Обнаружен обрыв глубиной', dropDepth, 'блоков — шагаю вниз')
        state.jumpHoldTicks = 0
        state.forwardHoldTicks = 16
        state.backHoldTicks = 0
        state.leftHoldTicks = 0
        state.rightHoldTicks = 0
        bot.setControlState('sneak', false)
        bot.setControlState('forward', true)
      } else if (isRealStep) {
        // 1-блок ступенька: прыгаем вперёд
        state.jumpHoldTicks = 5
        state.forwardHoldTicks = 12
        state.backHoldTicks = 0
        state.leftHoldTicks = 0
        state.rightHoldTicks = 0
        bot.setControlState('jump', true)
      } else if (isStepObstacle) {
        // Real 1-block step: push jump forward aggressively.
        state.jumpHoldTicks = 5
        state.forwardHoldTicks = 12
        state.backHoldTicks = 0
        state.leftHoldTicks = 0
        state.rightHoldTicks = 0
        bot.setControlState('jump', true)
      } else if (isWallObstacle) {
        // 2-block/high wall ahead: jump won't help, force side-unstick.
        state.jumpHoldTicks = 0
        state.forwardHoldTicks = 3
        state.backHoldTicks = 2
        state.leftHoldTicks = state.tickCounter % 2 === 0 ? 4 : 0
        state.rightHoldTicks = state.tickCounter % 2 === 1 ? 4 : 0
      } else {
        // Side collision / airborne collision: unstick first, then re-approach.
        state.jumpHoldTicks = 0
        state.backHoldTicks = 3
        state.leftHoldTicks = state.tickCounter % 2 === 0 ? 3 : 0
        state.rightHoldTicks = state.tickCounter % 2 === 1 ? 3 : 0
      }
      // #region agent log
      debugLog('H7', 'bot.js:handleAntiStuck', 'recovery step1 control states set', {
        onGround: bot.entity?.onGround,
        collided: bot.entity?.isCollidedHorizontally,
        velY: bot.entity?.velocity?.y,
        jumpHoldTicks: state.jumpHoldTicks,
        forwardHoldTicks: state.forwardHoldTicks,
        backHoldTicks: state.backHoldTicks,
        leftHoldTicks: state.leftHoldTicks,
        rightHoldTicks: state.rightHoldTicks,
        isStepObstacle,
        isWallObstacle,
        frontChestBlock: frontChestName,
        frontFeetBlock: frontFeetName,
        autoJumpCanJump,
        autoJumpShouldJump
      }, 'post-fix')
      // #endregion
      // #region agent log
      debugLog('H5', 'bot.js:handleAntiStuck', 'recovery step 1 jump-forward', {
        recoverUntil: state.recoverUntil,
        controlJump: state.jumpHoldTicks > 0,
        controlForward: true,
        frontBlock: frontChestName
      })
      // #endregion

      return
    }

    // Шаг 2: fallback goal reset when looping in place
    if (state.stuckCount === 2) {
      const targetEntity = getPlayerEntity(state.targetUsername)
      if (targetEntity) {
        state.isRecovering = true
        state.recoverUntil = Date.now() + 1200
        state.repathCooldownTicks = 16

        const p = targetEntity.position
        bot.pathfinder.setGoal(null)
        bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2), false)
        state.jumpHoldTicks = Math.max(state.jumpHoldTicks, 4)
        bot.setControlState('jump', true)
        // #region agent log
        const scaffoldCount = typeof movement?.scafoldingBlocks?.size === 'number'
          ? movement.scafoldingBlocks.size
          : Array.isArray(movement?.scafoldingBlocks)
            ? movement.scafoldingBlocks.length
            : null
        debugLog('H3', 'bot.js:handleAntiStuck', 'recovery step 2 reset-to-goalnear', {
          targetDx: p.x - bot.entity.position.x,
          targetDy: p.y - bot.entity.position.y,
          targetDz: p.z - bot.entity.position.z,
          scaffoldCount,
          frontBlock: frontChestName,
          frontFeetBlock: frontFeetName,
          onGround: bot.entity?.onGround,
          collided: bot.entity?.isCollidedHorizontally
        })
        // #endregion
      }
      return
    }

    // Шаг 3: hard fallback repath
    if (state.stuckCount >= CONFIG.maxStuckCountBeforeNudge) {
      const targetEntity = getPlayerEntity(state.targetUsername)
      if (targetEntity) {
        state.isRecovering = true
        state.recoverUntil = Date.now() + 1200
        state.repathCooldownTicks = 12

        bot.pathfinder.setGoal(null)
        if (state.mode === 'follow') {
          state.jumpHoldTicks = Math.max(state.jumpHoldTicks, 4)
          bot.setControlState('jump', true)
        }
        if (state.mode === 'follow' || state.mode === 'guard') repathToTarget(true)
      }
      state.stuckCount = 0
      return
    }
  } else {
    // #region agent log
    debugLog('H2', 'bot.js:handleAntiStuck', 'stuck reset (movement or no collision)', {
      moved,
      threshold: effectiveThreshold,
      collided
    }, 'post-fix')
    // #endregion
    state.stuckCount = 0
  }
}

function handleGuardCombat() {
  if (state.mode !== 'guard') return
  if (state.tickCounter % CONFIG.guardScanIntervalTicks !== 0) return

  const ownerEntity = getPlayerEntity(state.targetUsername)
  if (!ownerEntity || !bot.entity) return

  const threat = bot.nearestEntity((e) => {
    if (!e || e.type !== 'mob') return false
    if (e.mobType === 'Armor Stand') return false

    const distToBot = e.position.distanceTo(bot.entity.position)
    const distToOwner = e.position.distanceTo(ownerEntity.position)
    return distToBot <= CONFIG.guardMobDistance && distToOwner <= CONFIG.guardMobDistance
  })

  if (threat && !bot.pvp.target) {
    log('Guard attack:', threat.name || threat.mobType || 'mob')
    bot.pvp.attack(threat)
  }
}

function handlePhysicsTick() {
  state.tickCounter++
  if (state.repathCooldownTicks > 0) state.repathCooldownTicks -= 1
  // forward/back/left/right НЕ сбрасываем в false — pathfinder управляет ими сам.
  if (state.forwardHoldTicks > 0) { state.forwardHoldTicks -= 1; bot.setControlState('forward', true) }
  if (state.backHoldTicks > 0) { state.backHoldTicks -= 1; bot.setControlState('back', true) }
  if (state.leftHoldTicks > 0) { state.leftHoldTicks -= 1; bot.setControlState('left', true) }
  if (state.rightHoldTicks > 0) { state.rightHoldTicks -= 1; bot.setControlState('right', true) }

  // Jump over 1-block obstacles: briefly pause pathfinder, jump+forward, resume
  // Cooldown через repathCooldownTicks чтобы не срабатывал каждый тик при затяжной коллизии
  if ((state.mode === 'follow' || state.mode === 'guard') &&
      state.jumpHoldTicks === 0 && state.repathCooldownTicks === 0 && !state.isRecovering) {
    const ent = bot.entity
    if (ent && ent.onGround && ent.isCollidedHorizontally) {
      state.jumpHoldTicks = 8
      state.repathCooldownTicks = 15  // не срабатываем снова ближайшие ~0.75 сек
      if (typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop()
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      setTimeout(() => {
        if (state.mode === 'follow' || state.mode === 'guard') repathToTarget(true)
      }, 400)
    }
  }

  // Применяем jumpHoldTicks
  if (state.jumpHoldTicks > 0) {
    state.jumpHoldTicks -= 1
    bot.setControlState('jump', true)
  } else {
    bot.setControlState('jump', false)
  }

  // Переобновляем follow/guard редко, чтобы не срывать копку/маневр
  if (state.mode === 'follow' || state.mode === 'guard') {
    repathToTarget(false)
  }
  tickBaritoneFollow()

  // Fallback: detect pathfinder looping in place and force jump/repath
  if (!state.isRecovering && state.mode === 'follow' && bot.entity && state.tickCounter % CONFIG.loopGuardTicks === 0) {
    const moved = state.lastStuckPos ? bot.entity.position.distanceTo(state.lastStuckPos) : 1
    if (moved < CONFIG.loopMoveThreshold) {
      state.loopTicks += 1
    } else {
      state.loopTicks = 0
    }
    if (state.loopTicks >= 3) {
      const front = getFrontBlock()
      if (CONFIG.debugMovement) {
        logStuckContext('loop-guard')
      }
      state.jumpHoldTicks = Math.max(state.jumpHoldTicks, 4)
      bot.setControlState('jump', true)
      state.repathCooldownTicks = 10
      repathToTarget(true)
      debugLog('H8', 'bot.js:handlePhysicsTick', 'loop guard forced jump+repath', {
        loopTicks: state.loopTicks,
        moved,
        frontBlock: front?.chestBlock?.name || null,
        repathCooldownTicks: state.repathCooldownTicks
      }, 'post-fix')
      state.loopTicks = 0
    }
  }

  handleAntiStuck()
  handleGuardCombat()
}

// ---------- Claude AI ----------
function getBotContext() {
  const inv = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || 'empty'
  const health = bot.health?.toFixed(1) ?? '?'
  const food = bot.food ?? '?'
  const pos = bot.entity?.position
  const posStr = pos ? `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}` : '?'
  const armor = ['head','torso','legs','feet'].map(slot => {
    const item = bot.inventory.slots[{ head: 5, torso: 6, legs: 7, feet: 8 }[slot]]
    return item ? item.name : 'none'
  }).join(', ')
  return `Mode: ${state.mode} | Target: ${state.targetUsername || 'none'} | HP: ${health}/20 | Food: ${food}/20 | Pos: ${posStr} | Armor: [${armor}] | Inventory: ${inv}`
}

async function askClaude(userMessage, isAutonomous = false) {
  if (!CONFIG.anthropicApiKey) {
    return askNvidia(userMessage)
  }

  const systemPrompt = isAutonomous
    ? `You are an autonomous Minecraft bot assistant. Based on the bot state, decide what to do next.
Available commands you can trigger by including them in your response wrapped in <action> tags:
<action>follow</action> - follow the owner
<action>stop</action> - stop moving
<action>craft_gear</action> - craft iron gear if possible
<action>come</action> - go to owner

Current bot state: \${getBotContext()}

Respond with a SHORT action description (under 50 chars for chat) and optionally one <action> tag.
Only act if something clearly needs doing. If everything is fine, respond with <action>none</action>.`
    : `You are a Minecraft bot companion. You can chat AND execute commands.
If the player asks you to do something, include an <action> tag in your response.
Available actions: <action>follow</action>, <action>stop</action>, <action>craft_gear</action>, <action>come</action>
Current bot state: \${getBotContext()}
Respond in the same language as the player. Keep responses short (under 100 chars). No formatting.`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CONFIG.aiTimeoutMs)

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const err = await response.text().catch(() => '')
      log('Claude API error:', response.status, err.slice(0, 200))
      return askNvidia(userMessage)
    }

    const data = await response.json()
    const text = data?.content?.[0]?.text?.trim() || ''

    // Extract and execute action if present
    const actionMatch = text.match(/<action>(\w+)<\/action>/)
    if (actionMatch) {
      const action = actionMatch[1]
      log(`[claude] action: ${action}`)
      const owner = state.targetUsername || CONFIG.allowedUsers[0] || null
      if (action === 'follow' && owner) setModeFollow(owner)
      else if (action === 'stop') setModeIdle()
      else if (action === 'come' && owner) setModeCome(owner)
      else if (action === 'craft_gear') craftGear().catch(e => log('[craft] error:', e.message))
    }

    // Return clean text without action tags
    return text.replace(/<action>[\w]+<\/action>/g, '').trim() || null
  } catch (err) {
    if (err.name === 'AbortError') return 'Thinking too long, try again.'
    log('Claude API error:', err.message)
    return askNvidia(userMessage)
  } finally {
    clearTimeout(timeout)
  }
}

function startAutonomousLoop() {
  if (state.autonomousTimer) clearInterval(state.autonomousTimer)
  state.autonomousTimer = setInterval(async () => {
    if (!bot?.entity || !CONFIG.anthropicApiKey) return
    // Only act autonomously if bot is idle or following
    if (state.mode !== 'idle' && state.mode !== 'follow') return
    try {
      const reply = await askClaude('Autonomous check. What should I do?', true)
      if (reply && reply !== '' && !reply.toLowerCase().includes('none')) {
        safeChat(reply)
      }
    } catch (e) {
      log('[autonomous] error:', e.message)
    }
  }, 15000) // every 15 seconds
}

// ---------- Crafting ----------
async function craftGear() {
  if (!mcData) return safeChat('Not ready yet.')

  // Count iron ingots in inventory
  const iron = bot.inventory.items().filter(i => i.name === 'iron_ingot')
  const ironCount = iron.reduce((s, i) => s + i.count, 0)
  log(`[craft] iron ingots: ${ironCount}`)

  if (ironCount < 5) {
    safeChat(`Not enough iron. Have ${ironCount}, need at least 5.`)
    return
  }

  // Find crafting table nearby or in inventory
  let craftingTable = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 })

  if (!craftingTable) {
    // Place one from inventory if we have it
    const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table')
    if (tableItem) {
      safeChat('Placing crafting table...')
      const refBlock = bot.blockAt(bot.entity.position.offset(1, -1, 0))
      if (refBlock) {
        await bot.equip(tableItem, 'hand')
        await bot.placeBlock(refBlock, new Vec3(0, 1, 0))
        await bot.waitForTicks(5)
        craftingTable = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 5 })
      }
    }
  }

  if (!craftingTable) {
    safeChat('No crafting table nearby and none in inventory!')
    return
  }

  // Walk to crafting table
  const p = craftingTable.position
  await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2))

  // Items to craft in order (need crafting table for all armor+sword)
  // Each entry: [itemName, count]
  const wantedGear = [
    'iron_helmet',
    'iron_chestplate',
    'iron_leggings',
    'iron_boots',
    'iron_sword',
  ]

  let crafted = []
  let skipped = []

  for (const itemName of wantedGear) {
    // Skip if already have it equipped or in inventory
    const alreadyHave = bot.inventory.items().some(i => i.name === itemName)
    const equipped = Object.values(bot.inventory.slots).some(s => s?.name === itemName)
    if (alreadyHave || equipped) { skipped.push(itemName); continue }

    const recipe = bot.recipesFor(mcData.itemsByName[itemName].id, null, 1, craftingTable)[0]
    if (!recipe) { skipped.push(itemName + '(no recipe)'); continue }

    try {
      await bot.craft(recipe, 1, craftingTable)
      crafted.push(itemName)
      log(`[craft] crafted ${itemName}`)
      await bot.waitForTicks(2)
    } catch (e) {
      log(`[craft] failed ${itemName}: ${e.message}`)
      skipped.push(itemName + '(no materials)')
    }
  }

  // Equip armor
  const armorSlots = {
    iron_helmet: 'head',
    iron_chestplate: 'torso',
    iron_leggings: 'legs',
    iron_boots: 'feet',
  }
  for (const [itemName, slot] of Object.entries(armorSlots)) {
    const item = bot.inventory.items().find(i => i.name === itemName)
    if (item) {
      try { await bot.equip(item, slot) } catch (e) { log(`[craft] equip ${itemName} failed: ${e.message}`) }
    }
  }

  const msg = crafted.length > 0
    ? `Crafted: ${crafted.join(', ')}` + (skipped.length ? ` | Skipped: ${skipped.join(', ')}` : '')
    : `Nothing to craft. Skipped: ${skipped.join(', ')}`
  safeChat(msg)
}

function parseCommand(messageLower) {
  if (messageLower.includes('иди ко мне') || messageLower === 'come') return 'come'
  if (messageLower === 'следуй за мной') return 'follow'
  if (messageLower === 'защищай меня') return 'guard'
  if (messageLower === 'стой') return 'stop'
  if (messageLower.includes('скрафти снарягу')) return 'craft_gear'
  return null
}

async function askNvidia(userMessage) {
  if (!CONFIG.nvidiaApiKey) {
    return 'Я без API-ключа. Добавь NVIDIA_API_KEY в переменные окружения.'
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CONFIG.aiTimeoutMs)

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.nvidiaApiKey}`
      },
      body: JSON.stringify({
        model: CONFIG.nvidiaModel,
        messages: [
          {
            role: 'system',
            content:
              "Ты помощник и телохранитель в Майнкрафте. Отвечай коротко, по-русски, без форматирования. Команды: 'следуй за мной', 'защищай меня', 'стой', 'иди ко мне'."
          },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 60
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      log('NVIDIA API HTTP error:', response.status, errText.slice(0, 250))
      return 'Сервер ИИ сейчас недоступен.'
    }

    const data = await response.json()
    const answer = data?.choices?.[0]?.message?.content?.trim()
    if (!answer) return 'Не понял, повтори коротко.'
    return answer
  } catch (err) {
    if (err.name === 'AbortError') {
      log('NVIDIA API timeout')
      return 'Долго думаю. Повтори запрос.'
    }
    log('NVIDIA API error:', err.message)
    return 'Ошибка ИИ. Попробуй снова.'
  } finally {
    clearTimeout(timeout)
  }
}

async function onChat(username, message) {
  if (username === bot.username) return
  if (!isAllowedUser(username)) return

  log(`[${username}] ${message}`)

  const msg = String(message || '').toLowerCase().trim()
  const command = parseCommand(msg)
  const playerEntity = getPlayerEntity(username)

  if (command === 'come') {
    if (!playerEntity) return safeChat('Я тебя не вижу!')
    safeChat('Бегу!')
    setModeCome(username)
    return
  }

  if (command === 'follow') {
    if (!playerEntity) return safeChat('Я тебя не вижу!')
    safeChat('Окей, следую за тобой.')
    setModeFollow(username)
    return
  }

  if (command === 'guard') {
    if (!playerEntity) return safeChat('Подойди поближе!')
    safeChat('Режим телохранителя включен.')
    setModeGuard(username)
    return
  }

  if (command === 'stop') {
    safeChat('Остановился.')
    setModeIdle()
    return
  }

  if (command === 'craft_gear') {
    safeChat('Checking inventory and crafting...')
    craftGear().catch(e => {
      log('[craft] error:', e.message)
      safeChat('Craft failed: ' + e.message.slice(0, 80))
    })
    return
  }

  if (msg === 'автопрыжок вкл') {
    bot.autoJump?.enable()
    safeChat('Автопрыжок включен.')
    return
  }

  if (msg === 'автопрыжок выкл') {
    bot.autoJump?.disable()
    safeChat('Автопрыжок выключен.')
    return
  }

  if (msg === 'статус пути') {
    const front = getFrontBlock()
    const feet = getFeetBlock()
    safeChat(`mode=${state.mode}, stuck=${state.stuckCount}, front=${front?.chestBlock?.name || 'air'}, feet=${feet?.name || 'air'}`)
    return
  }

  // AI fallback with cooldown
  const now = Date.now()
  const elapsed = now - state.lastAiReplyAt
  if (elapsed < CONFIG.aiCooldownMs) return

  state.lastAiReplyAt = now
  const aiReply = await askClaude(message)
  if (aiReply) safeChat(aiReply)
}

function scheduleReconnect(reason) {
  if (state.reconnectTimer) return

  state.reconnectAttempts += 1
  const delay = Math.min(1000 * 2 ** (state.reconnectAttempts - 1), CONFIG.reconnectMaxDelayMs)
  log(`Reconnect scheduled in ${delay}ms. Reason: ${reason}`)

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    startBot()
  }, delay)
}

function bindBotEvents() {
  bot.on('spawn', handleSpawn)
  bot.on('physicsTick', handlePhysicsTick)
  bot.on('playerCollect', () => refreshScaffoldingBlocks())
  bot.on('windowUpdate', () => refreshScaffoldingBlocks())
  bot.on('chat', (username, message) => {
    onChat(username, message).catch((err) => log('chat handler error:', err.message))
  })

  bot.on('path_update', (r) => {
    // Иногда полезно для дебага тупняков
    if (r.status === 'noPath') log('Pathfinder: noPath')
    if (r.status === 'timeout') log('Pathfinder: timeout')
    // #region agent log
    if (r.status === 'noPath' || r.status === 'timeout' || r.status === 'partial') {
      debugLog('H4', 'bot.js:path_update', 'path update status', {
        status: r.status,
        pathLength: Array.isArray(r.path) ? r.path.length : null,
        visitedNodes: r.visitedNodes ?? null,
        time: r.time ?? null,
        mode: state.mode
      })
    }
    // #endregion
  })

  bot.on('goal_reached', () => {
    if (state.mode === 'come') setModeIdle()
  })

  bot.on('error', (err) => {
    log('Bot error:', err.message)
  })

  bot.on('kicked', (reason) => {
    log('Bot kicked:', reason)
  })

  bot.on('end', () => {
    log('Bot disconnected')
    scheduleReconnect('end')
  })

  bot.once('spawn', () => {
    state.reconnectAttempts = 0
  })
}

function startBot() {
  log('Starting bot...', {
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version
  })

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: CONFIG.auth
  })

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvp)
  bot.loadPlugin(autoJump)
  bot.loadPlugin(baritoneLoader)
  bindBotEvents()
}

// ---------- Start ----------
startBot()

process.on('SIGINT', () => {
  log('SIGINT received, shutting down...')
  try {
    setModeIdle()
    bot?.quit('bye')
  } catch (_) {
    // ignore
  } finally {
    process.exit(0)
  }
})