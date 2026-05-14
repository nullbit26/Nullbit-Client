'use strict'

/**
 * Legacy anti-stuck + corner sidestep (extracted from `actions/movement.js` without logic changes).
 * `movement.js` builds a `ctx` bag and delegates here.
 *
 * @typedef {Object} AntiStuckCtx
 * @property {import('mineflayer').Bot} bot
 * @property {object} config
 * @property {object} state
 * @property {Function} log
 * @property {Function} getFrontBlock
 * @property {Function} getFeetBlock
 * @property {Function} getPlayerEntity
 * @property {Function} interruptPathfinder
 * @property {Function} handleStuckRecovery
 * @property {Function} tryMineBarrierAhead
 * @property {Function} pathfinderIsMoving
 * @property {Function} horizontalSpeed
 */

/**
 * @param {AntiStuckCtx} ctx
 * @param {() => void} done
 * @param {number|undefined|null} sidestepMsOpt
 */
function applyCornerSidestepThen (ctx, done, sidestepMsOpt) {
  const { bot, config, state, interruptPathfinder } = ctx
  const msDefault = Number(config.pathCornerSidestepMs) || 0
  const ms =
    sidestepMsOpt !== undefined && sidestepMsOpt !== null && Number(sidestepMsOpt) > 0
      ? Number(sidestepMsOpt)
      : msDefault
  if (!ms || ms <= 0 || !bot.entity) {
    done()
    return
  }
  interruptPathfinder()

  state.cornerStrafeRight = !state.cornerStrafeRight
  const sideKey = state.cornerStrafeRight ? 'right' : 'left'
  bot.setControlState(sideKey, true)
  if (config.pathCornerSidestepJump && bot.entity.onGround) {
    bot.setControlState('jump', true)
    setTimeout(() => bot.setControlState('jump', false), 90)
  }
  setTimeout(() => {
    bot.setControlState(sideKey, false)
    bot.setControlState('jump', false)
    done()
  }, ms)
}

/**
 * @param {AntiStuckCtx} ctx
 */
function tickPathStallEscape (ctx) {
  const { bot, config, state, log, interruptPathfinder, handleStuckRecovery, tryMineBarrierAhead, pathfinderIsMoving } =
    ctx
  if (config.navAssistEnabled && !config.navAssistLegacyPathStall) return
  if (!(state.mode === 'follow' || state.mode === 'guard' || state.mode === 'come')) {
    state.pathStallTicks = 0
    state.lastPathProgressPos = null
    return
  }
  if (Date.now() < (state.stallRecoveryGraceUntil || 0)) return
  if (state.isRecovering) return
  if (Date.now() - (state.lastCornerEscapeAt || 0) < config.pathCornerEscapeCooldownMs) return

  if (!pathfinderIsMoving() || !bot.entity) {
    state.pathStallTicks = 0
    if (bot.entity?.position) state.lastPathProgressPos = bot.entity.position.clone()
    return
  }

  if (!state.lastPathProgressPos) {
    state.lastPathProgressPos = bot.entity.position.clone()
    state.pathStallTicks = 0
    return
  }

  const stallEps = Number(config.pathStallProgressEpsilon) || 0.15
  const moved = bot.entity.position.distanceTo(state.lastPathProgressPos)
  if (moved > stallEps) {
    state.lastPathProgressPos = bot.entity.position.clone()
    state.pathStallTicks = 0
    return
  }

  state.pathStallTicks += 1
  if (state.pathStallTicks < config.pathStallEscapeTicks) return

  state.pathStallTicks = 0
  state.lastPathProgressPos = bot.entity.position.clone()
  state.lastCornerEscapeAt = Date.now()
  state.stuckCount = 0
  log('[stuck] path stall (edge/corner) → recovery (repath/descent), dig deferred')

  interruptPathfinder()
  state.repathCooldownTicks = 0
  state.isRecovering = false

  setTimeout(() => {
    const collided = !!bot.entity?.isCollidedHorizontally
    const pathActive = pathfinderIsMoving()
    const cornerMs = Number(config.pathCornerSidestepMs) || 0
    const microMs = Number(config.pathStallMicroSidestepMs) || 120
    const tryNudge = cornerMs > 0 && (collided || pathActive)

    function repathAfterStall () {
      handleStuckRecovery('path_stall')
      if (config.pathMineBarrierWhenStuck) {
        setTimeout(() => tryMineBarrierAhead(), 650)
      }
    }

    if (tryNudge) {
      log('[tuning] angle/step fallback before repath')
      const nudgeMs = collided ? undefined : microMs
      applyCornerSidestepThen(ctx, () => repathAfterStall(), nudgeMs)
    } else {
      repathAfterStall()
    }
  }, 45)
}

/**
 * @param {AntiStuckCtx} ctx
 */
function handleAntiStuck (ctx) {
  const {
    bot,
    config,
    state,
    log,
    getFrontBlock,
    getFeetBlock,
    interruptPathfinder,
    handleStuckRecovery,
    tryMineBarrierAhead,
    pathfinderIsMoving,
    horizontalSpeed
  } = ctx
  if (config.navAssistEnabled && !config.navAssistLegacyAntiStuck) return
  if (!(state.mode === 'follow' || state.mode === 'guard' || state.mode === 'come')) return
  const stuckInterval = config.stuckCheckTicks || 11
  const checkEvery =
    state.mode === 'guard'
      ? Math.max(stuckInterval, Number(config.guardStuckCheckTicks) || 14)
      : stuckInterval
  if (state.tickCounter % checkEvery !== 0) return
  if (state.mode === 'guard' && checkEvery > stuckInterval && !state.guardStallRelaxLogged) {
    state.guardStallRelaxLogged = true
    log('[tuning] guard stall threshold relaxed')
  }
  if (!bot.entity) return

  if (state.isRecovering && Date.now() >= state.recoverUntil) state.isRecovering = false
  if (!state.lastStuckPos) {
    state.lastStuckPos = bot.entity.position.clone()
    return
  }

  const moved = bot.entity.position.distanceTo(state.lastStuckPos)
  state.lastStuckPos = bot.entity.position.clone()
  const collided = !!bot.entity?.isCollidedHorizontally
  const velY = bot.entity.velocity?.y ?? 0
  const calmVertical = Math.abs(velY) < 0.07
  const hungInFoliage = !bot.entity.onGround && calmVertical
  const len = config.stuckMoveLenience ?? 1.25
  const hMax = config.stuckCornerVelocityMax ?? 0.048
  const pathActive = pathfinderIsMoving()
  const noProgressLoose = moved < config.stuckMoveThreshold * len
  const cornerStuck =
    noProgressLoose &&
    horizontalSpeed() < hMax &&
    (collided || pathActive)
  const classicStuck =
    moved < config.stuckMoveThreshold &&
    (collided || hungInFoliage || (!bot.entity.onGround && velY === 0))
  const isStuck = classicStuck || cornerStuck

  if (!isStuck) {
    state.stuckCount = Math.max(0, state.stuckCount - 1)
    state.antiStuckScheduled = false
    if (state.antiStuckTimeoutId != null) {
      try {
        clearTimeout(state.antiStuckTimeoutId)
      } catch (_) {}
      state.antiStuckTimeoutId = null
    }
    return
  }

  state.stuckCount += 1
  if (config.debugMovement) {
    const front = getFrontBlock()
    const feet = getFeetBlock()
    log('[stuck-debug]', {
      mode: state.mode,
      frontFeet: front?.feetBlock?.name || null,
      frontChest: front?.chestBlock?.name || null,
      feet: feet?.name || null
    })
  }

  if (state.stuckCount === 1) {
    if (state.antiStuckScheduled) return
    const baseRepath = Math.max(0, config.pathRepathAfterStuckMs ?? 70)
    const repathDelay = state.mode === 'guard' ? baseRepath + 90 : baseRepath
    const fastBarrierMs = config.pathFastBarrierAfterRepathMs ?? 0
    state.antiStuckScheduled = true
    state.isRecovering = true
    const recoverPad = state.mode === 'guard' ? 780 : 500
    state.recoverUntil = Date.now() + repathDelay + fastBarrierMs + recoverPad
    state.repathCooldownTicks = 8
    interruptPathfinder()
    state.antiStuckTimeoutId = setTimeout(() => {
      state.antiStuckTimeoutId = null
      state.antiStuckScheduled = false
      state.isRecovering = false

      function doRepathAfterStuck () {
        handleStuckRecovery('anti_stuck_repath')

        if (config.pathMineBarrierWhenStuck && fastBarrierMs > 0) {
          const digDelay =
            state.mode === 'guard' ? Math.max(fastBarrierMs, 920) : Math.max(fastBarrierMs, 1000)
          setTimeout(() => {
            if (!(state.mode === 'follow' || state.mode === 'guard' || state.mode === 'come')) return
            if (!bot.entity) return
            const c = !!bot.entity.isCollidedHorizontally
            const vy = bot.entity.velocity?.y ?? 0
            const hung = !bot.entity.onGround && Math.abs(vy) < 0.07
            const hMax2 = config.stuckCornerVelocityMax ?? 0.048
            const cornerProbe = pathfinderIsMoving() && horizontalSpeed() < hMax2
            if (!c && !hung && !cornerProbe) return
            if (tryMineBarrierAhead()) state.stuckCount = 0
          }, digDelay)
        }
      }

      const cNow = !!bot.entity?.isCollidedHorizontally
      if (cNow && config.pathCornerSidestepMs > 0) {
        applyCornerSidestepThen(ctx, doRepathAfterStuck)
      } else {
        doRepathAfterStuck()
      }
    }, repathDelay)
    return
  }

  if (
    (state.stuckCount === 2 || state.stuckCount === 3 || state.stuckCount === 4) &&
    tryMineBarrierAhead()
  ) {
    state.stuckCount = 0
    return
  }

  if (state.stuckCount >= config.maxStuckCountBeforeNudge) {
    handleStuckRecovery('anti_stuck_max_nudge')
    state.stuckCount = 0
  }
}

module.exports = {
  applyCornerSidestepThen,
  tickPathStallEscape,
  handleAntiStuck
}
