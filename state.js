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
  /** When true, legacy `repathToTarget` skips pathfinder; {@link ../systems/FollowSystem} emits `nav:goto`. */
  navFollowViaBus: false,

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
  baritoneInFlight: false,

  /** throttling path_update → repath */
  lastNoPathRepathTick: -999999,
  /** wall-clock: последний полный recovery по path_noPath (анти-спам interrupt+repath) */
  lastNoPathStuckRecoveryAt: 0,

  /** Нет заметного смещения при активном pathfinder (угол, микроджиттер без horizontal collision) */
  pathStallTicks: 0,
  lastPathProgressPos: null,
  lastCornerEscapeAt: 0,
  /** Чередование left/right при sidestep от угла */
  cornerStrafeRight: false,

  /** Универсальный anti-stuck / obstacle (см. movement.js). */
  lastObstacleSignature: '',
  lastObstaclePos: null,
  lastObstacleName: '',
  lastObstacleDetectedAt: 0,
  obstacleAttemptCount: 0,
  obstacleRecoveryUntil: 0,
  obstacleBlockedSig: '',
  obstacleBlockedUntil: 0,
  obstacleConsecutiveDigFails: 0,
  lastProgressPos: null,
  lastProgressAt: 0,
  lastGoalProgressDist: null,
  /** throttle handleStuckRecovery при obstacle_repeat (см. movement). */
  lastObstacleForcedRepathAt: 0,

  /** Throttle + один отложенный anti-stuck (см. movement handleAntiStuck). */
  lastRecoveryAntiStuckAt: 0,
  lastRecoveryPathStallAt: 0,
  lastRecoveryPathUpdateAt: 0,
  antiStuckScheduled: false,
  antiStuckTimeoutId: null,

  /** После path_stall recovery — не копить stall-тики (мс). */
  stallRecoveryGraceUntil: 0,
  /** Единый wall-clock между любыми handleStuckRecovery. */
  lastRecoveryGlobalAt: 0,
  lastRecoveryContext: '',
  /** Подряд handleStuckRecovery без recordNavProgress-прогресса (анти-спам reset). */
  recoveryBurstCount: 0,
  guardStallRelaxLogged: false,

  /** anchor для smart stuck (nav-assist) */
  navAssistSmartAnchorPos: null,
  navAssistSmartAnchorMs: 0,
  navAssistRecoverPhase: '',
  navAssistRecoverBackEndPerf: 0,
  navAssistRecoverStrafeEndPerf: 0,
  navAssistRecoverSide: 'left',
  navAssistRecoverCooldownUntil: 0,
  navAssistCornerCutPerf: 0,
  navAssistVelocityStallSincePerf: 0,
  navAssistGoalDistAnchor: null,
  navAssistLowSpeedPerf: 0,
  navAssistPathfinderPausePerf: 0,
  navAssistLastSmartStuckLogAt: 0,

  /** «Отскок от стены»: фаза back+jump / ожидание / разворот+спринт */
  wallStickPhase: 'idle',
  wallStickManualDrive: false,
  wallStickSincePerf: 0,
  wallStickBackJumpEndPerf: 0,
  wallStickPfPauseUntilPerf: 0,
  wallStickSprintDriveEndPerf: 0,
  wallStickLastBounceAt: 0,
  wallStickLastSprintEscapeAt: 0
}

function resetStuckState(bot) {
  state.lastStuckPos = bot?.entity?.position?.clone?.() || null
  state.stuckCount = 0
  state.pathStallTicks = 0
  state.lastPathProgressPos = null
  state.lastCornerEscapeAt = 0
  state.cornerStrafeRight = false
  state.lastObstacleSignature = ''
  state.lastObstaclePos = null
  state.lastObstacleName = ''
  state.lastObstacleDetectedAt = 0
  state.obstacleAttemptCount = 0
  state.obstacleRecoveryUntil = 0
  state.obstacleBlockedSig = ''
  state.obstacleBlockedUntil = 0
  state.obstacleConsecutiveDigFails = 0
  state.lastProgressPos = bot?.entity?.position?.clone?.() || null
  state.lastProgressAt = Date.now()
  state.lastGoalProgressDist = null
  state.lastObstacleForcedRepathAt = 0
  state.lastRecoveryAntiStuckAt = 0
  state.lastRecoveryPathStallAt = 0
  state.lastRecoveryPathUpdateAt = 0
  state.lastNoPathStuckRecoveryAt = 0
  state.stallRecoveryGraceUntil = 0
  state.lastRecoveryGlobalAt = 0
  state.lastRecoveryContext = ''
  state.recoveryBurstCount = 0
  state.guardStallRelaxLogged = false
  state.navAssistSmartAnchorPos = bot?.entity?.position?.clone?.() || null
  state.navAssistSmartAnchorMs = Date.now()
  state.navAssistRecoverPhase = ''
  state.navAssistRecoverBackEndPerf = 0
  state.navAssistRecoverStrafeEndPerf = 0
  state.navAssistRecoverSide = 'left'
  state.navAssistRecoverCooldownUntil = 0
  state.navAssistCornerCutPerf = 0
  state.navAssistVelocityStallSincePerf = 0
  state.navAssistGoalDistAnchor = null
  state.navAssistLowSpeedPerf = 0
  state.navAssistPathfinderPausePerf = 0
  state.navAssistLastSmartStuckLogAt = 0
  state.wallStickPhase = 'idle'
  state.wallStickManualDrive = false
  state.wallStickSincePerf = 0
  state.wallStickBackJumpEndPerf = 0
  state.wallStickPfPauseUntilPerf = 0
  state.wallStickSprintDriveEndPerf = 0
  state.wallStickLastBounceAt = 0
  state.wallStickLastSprintEscapeAt = 0
  state.antiStuckScheduled = false
  if (state.antiStuckTimeoutId != null) {
    try {
      clearTimeout(state.antiStuckTimeoutId)
    } catch (_) {}
    state.antiStuckTimeoutId = null
  }
}

module.exports = {
  state,
  resetStuckState
}
