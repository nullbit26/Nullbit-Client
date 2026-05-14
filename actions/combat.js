module.exports = function createCombatActions (bot, deps) {
  const { config, state, utils, movementActions, resetStuckState, defend } = deps
  const { log, getPlayerEntity } = utils
  const { repathToTarget } = movementActions

  function setModeGuard (username) {
    if (defend && typeof defend.stopAllDefend === 'function') {
      defend.stopAllDefend({ silent: true })
    }
    state.mode = 'guard'
    state.targetUsername = username
    state.lastRepathTick = 0
    resetStuckState(bot)
    if (!state.navFollowViaBus) repathToTarget(true)
    log('Mode -> GUARD', username)
  }

  function handleGuardCombat () {
    const protectInFollow = config.followAutoProtect !== false
    const isProtectMode = state.mode === 'guard' || (protectInFollow && state.mode === 'follow')
    if (!isProtectMode) return
    if (state.tickCounter % config.guardScanIntervalTicks !== 0) return
    if (!defend || typeof defend.tickChatGuard !== 'function') return
    defend.tickChatGuard(state, getPlayerEntity, config)
  }

  return {
    setModeGuard,
    handleGuardCombat
  }
}
