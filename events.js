const applyPhysicsHitboxInflate = require('./physics-compat')
const {
  augmentMovementsHazards,
  applyGlobalCautiousWalk,
  applyGlobalLavaEscapeIfNeeded,
  applyProactiveHazardDetourSteer,
  evaluateCautiousWalk,
  touchesLavaOrInLava
} = require('./features/navSafety')
const { isCombatSessionActive } = require('./attackEntity')

const { VoiceEvents, NavEvents } = require('./core/EventRegistry')
const { CoreStates } = require('./core/StateManager')
const { mayControlBot, shouldEnqueueChatWhileBusy } = require('./utils/commandChatAccess')
const { parsePlayerMessage } = require('./commands/parsePlayerMessage')
const { createCommandContext } = require('./commands/commandContext')
const { dispatchCommand } = require('./commands/dispatchCommand')

/**
 * Chat routing:
 * - **Parse:** `commands/parsePlayerMessage` + `commands/commandRegistry`.
 * - **Execute:** `commands/dispatchCommand` → `commands/handlers/*` (movement, inventory, defend, combat `attack_direct`, party via dispatch hook, misc).
 * - **Context:** `commands/commandContext` bundles bot/deps + `stopAttackSilent`, inventory helpers, `safeChat`, `brain` / `getCoreState` (для политики чат-атаки), `defend`, `partyIFF`.
 * - **This file:** wiring (spawn, physics, path, chat queue), permission gate, AI fallback when parse returns null.
 * - **Combat chat command:** поведение `attack_direct` (резолв цели, FLEE/session/defend/override) — **`docs/COMMAND_SYSTEM_CURRENT.md` §7**.
 */

const MAX_PENDING_CHAT_QUEUE = 8

module.exports = function bindBotEvents(bot, deps) {
  const {
    config,
    state,
    resetStuckState,
    utils,
    ai,
    movementActions,
    combatActions,
    craftActions,
    voice,
    defend,
    eventBus,
    partyIFF,
    brain
  } = deps
  const {
    setupMovements,
    refreshScaffoldingBlocks,
    setModeIdle,
    repathToTarget,
    handleAntiStuck,
    tickPathStallEscape,
    tickNavAssist
  } = movementActions
  const { handleGuardCombat } = combatActions
  const { askAssistant } = ai
  const { log, getPlayerEntity } = utils

  let isProcessing = false
  /** @type {{ username: string, message: string }[]} */
  const pendingChat = []

  function safeChat(text) {
    const msg = Buffer.from(String(text || ''), 'utf8')
      .toString('utf8')
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}\s.,!?;:'"()\-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
    if (msg) bot.chat(msg)
  }

  const commandCtx = createCommandContext(bot, deps, { safeChat, log })

  function handleSpawn() {
    log('Bot spawned successfully')
    movementActions.setMcData(bot.version)
    setupMovements()
    try {
      if (bot.pathfinder?.movements) augmentMovementsHazards(bot, bot.pathfinder.movements)
    } catch (e) {
      log('[spawn] augmentMovementsHazards:', e?.message || e)
    }
    refreshScaffoldingBlocks()
    resetStuckState(bot)
    if (config.physicsHitboxInflate > 0) {
      applyPhysicsHitboxInflate(bot, config.physicsHitboxInflate)
      log(`physics hitbox inflate +${config.physicsHitboxInflate} (see mineflayer-pathfinder #223)`)
    }

    // Сбрасываем состояние боя при respawn
    if (brain?.combatSystem) {
      try { brain.combatSystem._endFlee('spawn') } catch (_) {}
      brain.combatSystem._consumeBusy = false
      brain.combatSystem._fleeNavLocked = false
      brain.combatSystem._noPathStreak = 0
      brain.combatSystem._fleeDirectionNx = 0
      brain.combatSystem._fleeDirectionNz = 0
    }
    if (brain?.memory) {
      brain.memory.setCurrentThreats([])
      brain.memory.setLastAttacker(null)
    }
    if (brain?.state?.getState() !== CoreStates.IDLE) {
      try { brain.state.transition(CoreStates.IDLE) } catch (_) {}
    }
  }

  function handlePhysicsTick() {
    state.tickCounter += 1
    if (state.repathCooldownTicks > 0) state.repathCooldownTicks -= 1

    if (typeof movementActions.recordNavProgress === 'function') movementActions.recordNavProgress()

    // Клавиши движения задаёт monitorMovement mineflayer-pathfinder до nav-assist; nav-assist вешается в inject_allowed — последним.
    // Early tick не должен массово сбрасывать jump без причины (ломался sprint+jump после патча pathfinder).

    if (state.mode === 'follow' || state.mode === 'guard') {
      if (!state.navFollowViaBus) repathToTarget(false)
    }

    tickPathStallEscape()

    if (!state.isRecovering && (state.mode === 'follow' || state.mode === 'guard') && bot.entity && state.tickCounter % config.loopGuardTicks === 0) {
      const followDist = state.mode === 'guard' ? config.guardFollowDistance : config.followDistance
      const targetEntity = getPlayerEntity(state.targetUsername)
      if (targetEntity && bot.entity.position.distanceTo(targetEntity.position) <= followDist + 0.35) {
        state.loopTicks = 0
      } else {
        const moved = state.lastStuckPos ? bot.entity.position.distanceTo(state.lastStuckPos) : 1
        state.loopTicks = moved < config.loopMoveThreshold ? state.loopTicks + 1 : 0
        if (state.loopTicks >= 3) {
          state.repathCooldownTicks = 10
          if (state.navFollowViaBus && eventBus) {
            const targetEntity = getPlayerEntity(state.targetUsername)
            if (targetEntity?.position && bot.entity) {
              const dist = state.mode === 'guard' ? config.guardFollowDistance : config.followDistance
              const p = targetEntity.position
              eventBus.emit(NavEvents.GOTO, { kind: 'near', x: p.x, y: p.y, z: p.z, range: dist })
              state.lastRepathTick = state.tickCounter
            }
          } else {
            repathToTarget(true)
          }
          state.loopTicks = 0
        }
      }
    }

    handleAntiStuck()
    handleGuardCombat()
  }

  async function onChat(username, message) {
    if (username === bot.username) return
    if (!mayControlBot(username, config, partyIFF)) return

    const raw = String(message || '').trim()
    const defendCapable = !!(
      defend &&
      (typeof defend.defendEntity === 'function' || typeof defend.defendPoint === 'function')
    )
    const parsed = parsePlayerMessage(raw, { source: 'chat', defendCapable })

    if (!parsed) {
      const now = Date.now()
      if (now - state.lastAiReplyAt < config.aiCooldownMs) return
      state.lastAiReplyAt = now
      const aiReply = await askAssistant(message, { spokeUsername: username })
      if (aiReply) {
        safeChat(aiReply)
        if (eventBus && typeof eventBus.emit === 'function') {
          eventBus.emit(VoiceEvents.SPEAK, { text: aiReply })
        } else if (voice && typeof voice.speak === 'function') {
          voice.speak(aiReply).catch((err) => log('[voice] speak (chat):', err.message))
        }
      }
      return
    }

    const dispatched = await dispatchCommand(commandCtx, parsed, { username, raw })
    if (!dispatched.handled) {
      log('[commands] not handled', {
        command: parsed.command,
        phase: dispatched.phase,
        logCode: dispatched.logCode
      })
    }
  }

  bot.on('path_update', (res) => {
    const st = res?.status
    if ((st === 'noPath' || st === 'timeout' || st === 'partial') && typeof movementActions.onPathfinderUpdate === 'function') {
      movementActions.onPathfinderUpdate(res)
    }
  })

  bot.on('spawn', handleSpawn)
  bot.on('physicsTick', handlePhysicsTick)
  /**
   * Pathfinder/nav-assist могут выставить jump в том же physicsTick после нашего sneak;
   * microtask снимает прыжок уже после всех синхронных слушателей.
   */
  function scheduleHazardCautiousJumpSuppress (b) {
    if (b._navSafetyHazardJumpSuppressQueued) return
    b._navSafetyHazardJumpSuppressQueued = true
    queueMicrotask(() => {
      b._navSafetyHazardJumpSuppressQueued = false
      if (isCombatSessionActive()) return
      if (evaluateCautiousWalk(b) || touchesLavaOrInLava(b)) b.setControlState('jump', false)
    })
  }
  /**
   * Nav-assist после pathfinder: иначе monitorMovement перезатирает left/right/forward
   * на следующий physics tick (см. mineflayer physics.js — emit physicsTick уже после simulatePlayer).
   */
  bot.once('inject_allowed', () => {
    if (typeof tickNavAssist === 'function') {
      bot.on('physicsTick', () => tickNavAssist())
    }
    // После nav-assist: осторожный sneak у обрыва/лавы; при активном бое не трогаем — владеет attackEntity.
    bot.on('physicsTick', () => {
      if (isCombatSessionActive()) return
      if (applyGlobalLavaEscapeIfNeeded(bot)) {
        scheduleHazardCautiousJumpSuppress(bot)
        return
      }
      if (applyProactiveHazardDetourSteer(bot)) {
        scheduleHazardCautiousJumpSuppress(bot)
        return
      }
      applyGlobalCautiousWalk(bot)
      if (evaluateCautiousWalk(bot)) scheduleHazardCautiousJumpSuppress(bot)
    })
  })
  bot.on('playerCollect', refreshScaffoldingBlocks)
  bot.on('windowUpdate', refreshScaffoldingBlocks)
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return

    const raw = String(message || '').trim()
    const defendCapableGate = !!(
      defend &&
      (typeof defend.defendEntity === 'function' || typeof defend.defendPoint === 'function')
    )

    if (isProcessing) {
      const mayCtrl = mayControlBot(username, config, partyIFF)
      const enqueue =
        mayCtrl &&
        shouldEnqueueChatWhileBusy({
          raw,
          source: 'chat',
          defendCapable: defendCapableGate
        })
      if (!enqueue) return
      if (pendingChat.length >= MAX_PENDING_CHAT_QUEUE) {
        log('[Chat] command queue full; dropping', { username, preview: raw.slice(0, 80) })
        return
      }
      pendingChat.push({ username, message })
      log('[Chat] queued while handler busy', { username, queueDepth: pendingChat.length, preview: raw.slice(0, 80) })
      return
    }

    isProcessing = true
    try {
      await onChat(username, message)
    } catch (e) {
      log('[Chat]', e?.message || e)
    }
    try {
      while (pendingChat.length > 0) {
        const next = pendingChat.shift()
        if (!next) break
        try {
          await onChat(next.username, next.message)
        } catch (e) {
          log('[Chat]', e?.message || e)
        }
      }
    } finally {
      isProcessing = false
    }
  })
  bot.on('goal_reached', () => {
    if (state.mode === 'come') setModeIdle()
  })
  bot.on('error', (err) => log('Bot error:', err.message))
  bot.on('kicked', (reason) => log('Bot kicked:', reason))
  bot.on('end', () => log('Bot disconnected'))
}
