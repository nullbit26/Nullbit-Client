'use strict'

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { GoalNear, GoalFollow } = goals
const NavMovements = require('./nav-movements')

const config = require('./config')
const { augmentMovementsHazards } = require('./features/navSafety')
const { equipBestWeapon } = require('./features/combatEquipment')
const { attackEntity, stopAttack, isCombatSessionActive } = require('./attackEntity')
const { waitUntilCombatInactive } = require('./combat/session/waitCombatInactive')
const { CoreEvents } = require('./core/EventRegistry')
const { CoreStates } = require('./core/StateManager')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Типы живых мобов в mineflayer из prismarine-registry: 1.21+ враги часто `hostile`, старые — `mob`. */
const MOB_THREAT_ENTITY_TYPES = new Set(['mob', 'hostile'])

/** Имена сущностей mineflayer (`entity.name`) — только точное совпадение, без includes. */
const PEACEFUL_MOB_NAMES = new Set([
  'allay',
  'axolotl',
  'armadillo',
  'bat',
  'bee',
  'camel',
  'cat',
  'chicken',
  'cod',
  'cow',
  'donkey',
  'frog',
  'glow_squid',
  'goat',
  'horse',
  'llama',
  'mooshroom',
  'mule',
  'mushroom',
  'ocelot',
  'parrot',
  'panda',
  'pig',
  'polar_bear',
  'pufferfish',
  'rabbit',
  'salmon',
  'sheep',
  'sniffer',
  'squid',
  'strider',
  'tadpole',
  'tropical_fish',
  'turtle',
  'villager',
  'wandering_trader',
  'fox',
  'trader_llama',
  'skeleton_horse',
  'zombie_horse'
])

function isPeacefulMob (e) {
  if (!e || !MOB_THREAT_ENTITY_TYPES.has(e.type)) return false
  const n = (e.name || '').toLowerCase()
  return PEACEFUL_MOB_NAMES.has(n)
}

/** @param {object} e mineflayer / prismarine entity */
function displayNameStr (e) {
  const d = e?.displayName
  if (d == null || d === '') return ''
  return typeof d === 'string' ? d : String(d)
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {import('vec3').Vec3} center
 * @param {number} radius
 * @param {{
 *   includePlayers?: boolean
 *   excludeUsername?: string
 *   excludeUsernames?: string[]
 *   exclude_players?: string[]
 * }} [opts]
 */
function findThreat (bot, center, radius, opts = {}) {
  const includePlayers = opts.includePlayers !== false
  const selfName = (bot.username || '').toLowerCase()
  const partyIFF = bot.partyIFF
  const excludeNames = new Set(
    [opts.excludeUsername, ...(opts.excludeUsernames || []), ...(opts.exclude_players || [])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
  )

  let best = null
  let bestD = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || e.id === bot.entity?.id) continue
    if (e.health !== undefined && e.health <= 0) continue
    if (!e.position || !center) continue
    const d = center.distanceTo(e.position)
    if (d > radius) continue

    const nameLower = (e.username || e.name || displayNameStr(e)).toLowerCase().trim()
    if (!nameLower) continue
    if (nameLower === selfName) continue
    if (excludeNames.has(nameLower)) continue

    if (e.type === 'player') {
      if (!includePlayers) continue
      if (partyIFF && typeof partyIFF.isDefenseThreatEntity === 'function') {
        if (!partyIFF.isDefenseThreatEntity(e, { excludeNames })) continue
      } else if (partyIFF?.isPartyUsername?.(nameLower)) continue
      if (d < bestD) {
        best = e
        bestD = d
      }
      continue
    }
    if (MOB_THREAT_ENTITY_TYPES.has(e.type)) {
      if (isPeacefulMob(e)) continue
      const mt = (displayNameStr(e) || e.name || '').toString()
      if (mt === 'Armor Stand' || nameLower === 'armor_stand') continue
      if (partyIFF && typeof partyIFF.isDefenseThreatEntity === 'function') {
        if (!partyIFF.isDefenseThreatEntity(e, { excludeNames })) continue
      }
      if (d < bestD) {
        best = e
        bestD = d
      }
    }
  }
  return best
}

module.exports = function createDefend (bot, deps = {}) {
  const { voice, utils, setModeIdle, getCoreState, eventBus, NavEvents: NavEventsBus, brain } = deps
  const log = utils?.log || ((...a) => console.log(...a))

  /** Снять follow/guard/come — иначе physicsTick в events тянет бота к игроку поверх охраны точки. */
  function cancelNavModes () {
    if (typeof setModeIdle === 'function') {
      try {
        setModeIdle()
      } catch (_) {}
    }
  }

  function resolvePlayerEntity (username) {
    const u = String(username || '').trim()
    if (!u) return null
    if (bot.players[u]?.entity) return bot.players[u].entity
    const low = u.toLowerCase()
    for (const k of Object.keys(bot.players || {})) {
      if (k.toLowerCase() === low) return bot.players[k].entity
    }
    return null
  }

  let defendActive = false
  let currentDefendKind = null
  let patrolAbort = false
  let patrolPromise = null
  let pointAbort = false
  let pointPromise = null
  let entityAbort = false
  let entityPromise = null
  let defendScanInterval = null

  const v = voice || { speak: async () => {} }

  /**
   * Pathfinder / bus-nav must not fight `attackEntity`, CombatSystem flee, or core COMBAT/FLEE.
   * FLEE блокирует явно (в т.ч. после `ceasePvpCombat`, пока сессия уже false).
   * Активная `CombatSession` / `isCombatSessionActive()` — **state lock**: не вызывать `setGoal` / bus `nav:goto`.
   * @returns {boolean}
   */
  function pathfinderYieldedToCombat () {
    if (typeof getCoreState === 'function') {
      const s = getCoreState()
      if (s === CoreStates.COMBAT) return true
      if (s === CoreStates.FLEE) return true
      if (brain && typeof brain.isFleeCooldown === 'function' && brain.isFleeCooldown()) return true
    }
    return isCombatSessionActive()
  }

  /**
   * Пока core в FLEE — ждём смены состояния (CoreEvents.STATE_CHANGED), не дольше totalMs.
   * @returns {boolean} true если по таймауту всё ещё FLEE — вызывающий цикл делает `continue`.
   */
  async function waitWhileCoreStateFlee (totalMs = 10000) {
    if (typeof getCoreState !== 'function') return false
    const deadline = Date.now() + totalMs
    while (getCoreState() === CoreStates.FLEE) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return true
      if (eventBus && typeof eventBus.on === 'function' && typeof eventBus.off === 'function') {
        await new Promise((resolve) => {
          const step = Math.min(500, Math.max(50, remaining))
          let finished = false
          const timer = setTimeout(finish, step)
          function onState () {
            if (getCoreState() !== CoreStates.FLEE) {
              finished = true
              clearTimeout(timer)
              try {
                eventBus.off(CoreEvents.STATE_CHANGED, onState)
              } catch (_) {}
              resolve()
            }
          }
          function finish () {
            if (!finished) {
              try {
                eventBus.off(CoreEvents.STATE_CHANGED, onState)
              } catch (_) {}
            }
            resolve()
          }
          eventBus.on(CoreEvents.STATE_CHANGED, onState)
        })
      } else {
        await sleep(Math.min(200, Math.max(50, remaining)))
      }
    }
    return false
  }

  async function waitUntilPathfinderFreeForDefend () {
    while (pathfinderYieldedToCombat()) {
      await sleep(120)
    }
  }

  function logPatrol (msg, ...rest) {
    log('[PATROL]', msg, ...rest)
  }
  function logPoint (msg, ...rest) {
    log('[DEFEND POINT]', msg, ...rest)
  }
  function logEntity (msg, ...rest) {
    log('[DEFEND ENTITY]', msg, ...rest)
  }

  async function speak (text) {
    if (typeof v.speak === 'function') {
      try {
        await v.speak(text)
      } catch (_) {}
    }
  }

  function clearScanInterval () {
    if (defendScanInterval != null) {
      clearInterval(defendScanInterval)
      defendScanInterval = null
    }
  }

  /** Ждём завершения сессии attackEntity (без гонки «два боя»). Только опрос `isCombatSessionActive()` — без CoreEvents.STATE_CHANGED. */
  async function waitUntilCombatEnds (maxMs = 120000) {
    await waitUntilCombatInactive({
      isActive: () => isCombatSessionActive(),
      maxMs,
      sleepMs: 80,
      sleep
    })
  }

  async function runCombatOnThreat (threat, label) {
    if (isCombatSessionActive()) {
      log(label, 'пропуск атаки: уже идёт бой (attackEntity)')
      return
    }
    const name = String(threat.username || threat.name || 'target')
    const entityId = threat.id
    log(label, 'атака:', name, 'id=', entityId)
    await attackEntity(bot, v, { entityName: name, entityId, strategy: 'aggressive' })
  }

  function stopAllDefend (opts = {}) {
    const silent = !!opts.silent
    defendActive = false
    currentDefendKind = null
    patrolAbort = true
    pointAbort = true
    entityAbort = true
    clearScanInterval()
    if (eventBus && NavEventsBus) {
      try {
        eventBus.emit(NavEventsBus.STOP, { reason: 'defend_stop_all' })
      } catch (_) {}
    }
    void stopAttack(bot, v)
    try {
      bot.pathfinder.setGoal(null)
    } catch (_) {}
    if (!silent) {
      void speak('Режим защиты отключён.')
    }
    log('[DEFEND]', 'stopAllDefend', silent ? '(silent)' : '')
  }

  /**
   * Чат-команда «защищай меня»: мобы/игроки рядом с владельцем, бот в пределах досягаемости.
   */
  function tickChatGuard (state, getPlayerEntity, config) {
    const protectInFollow = config.followAutoProtect !== false
    const isProtectMode = state.mode === 'guard' || (protectInFollow && state.mode === 'follow')
    if (!isProtectMode) return
    if (typeof getCoreState === 'function' && getCoreState() === CoreStates.FLEE) return
    if (brain && typeof brain.isFleeCooldown === 'function' && brain.isFleeCooldown()) return
    if (defendActive) return
    if (isCombatSessionActive()) return
    const owner = getPlayerEntity(state.targetUsername)
    if (!owner?.position || !bot.entity?.position) return

    const guardD = config.guardMobDistance != null ? Number(config.guardMobDistance) : 8
    const scanR = Math.min(14, Math.max(4, guardD))
    const threat = findThreat(bot, owner.position, scanR, {
      excludeUsername: state.targetUsername
    })
    if (!threat) return
    const dBot = threat.position.distanceTo(bot.entity.position)
    const dOwner = threat.position.distanceTo(owner.position)
    if (dBot > guardD + 2 || dOwner > guardD + 1) return

    void (async () => {
      await runCombatOnThreat(threat, '[DEFEND ENTITY]')
    })()
  }

  /** Pathfinder с blocksToAvoid (лава, огонь, кактус…) — те же правила, что в navSafety / бою. */
  function prepareDefendPathfinderSafety () {
    if (typeof bot.pathfinder?.setMovements !== 'function') return
    try {
      const movements = new NavMovements(bot, { cardinalOnly: !!config.pathCardinalOnly })
      augmentMovementsHazards(bot, movements)
      movements.allowParkour = false
      bot.pathfinder.setMovements(movements)
    } catch (e) {
      log('[DEFEND]', 'pathfinder hazard movements:', e?.message || e)
    }
  }

  async function safeGoto (x, y, z, range = 2, label) {
    await waitUntilPathfinderFreeForDefend()
    if (pathfinderYieldedToCombat()) return

    const target = new Vec3(x, y, z)
    const nearEnough = () => {
      if (!bot.entity?.position) return false
      return bot.entity.position.distanceTo(target) <= range + 1.25
    }

    if (eventBus && NavEventsBus) {
      let settled = false
      const onArrived = () => {
        if (nearEnough()) settled = true
      }
      const maxMs = 90000
      const t0 = Date.now()
      eventBus.on(NavEventsBus.ARRIVED, onArrived)
      try {
        try {
          eventBus.emit(NavEventsBus.STOP, { reason: 'defend_patrol_leg_setup' })
        } catch (_) {}
        await sleep(40)
        prepareDefendPathfinderSafety()
        eventBus.emit(NavEventsBus.GOTO, { kind: 'near', x, y, z, range })
        while (!settled && Date.now() - t0 < maxMs && defendActive) {
          if (pathfinderYieldedToCombat()) {
            try {
              eventBus.emit(NavEventsBus.STOP, { reason: 'defend_yield_combat' })
            } catch (_) {}
            break
          }
          if (nearEnough()) {
            settled = true
            break
          }
          await sleep(100)
        }
      } catch (e) {
        log(label, 'bus goto:', e?.message || e)
      } finally {
        try {
          eventBus.off(NavEventsBus.ARRIVED, onArrived)
        } catch (_) {}
      }
      return
    }

    prepareDefendPathfinderSafety()
    try {
      await bot.pathfinder.goto(new GoalNear(x, y, z, range))
    } catch (e) {
      log(label, 'goto:', e?.message || e)
    }
  }

  async function patrolMode (opts = {}) {
    if (!config.defendPatrolEnabled) {
      logPatrol('skipped: PATROL disabled (experimental). Set PATROL_ENABLED=1 to enable.')
      return { ok: false, mode: 'patrol', reason: 'patrol_disabled' }
    }
    stopAllDefend({ silent: true })
    cancelNavModes()
    defendActive = true
    currentDefendKind = 'patrol'
    patrolAbort = false

    const R = Math.min(48, Math.max(8, Number(opts.radius) || 25))
    const patrolExclude = opts.exclude_players || opts.excludeUsernames
    const patrolExcludeOpts =
      Array.isArray(patrolExclude) && patrolExclude.length
        ? { excludeUsernames: patrolExclude }
        : {}
    const pos = bot.entity.position
    const center =
      opts.center &&
      Number.isFinite(opts.center.x) &&
      Number.isFinite(opts.center.y) &&
      Number.isFinite(opts.center.z)
        ? opts.center
        : typeof pos.clone === 'function'
          ? pos.clone()
          : new Vec3(pos.x, pos.y, pos.z)

    logPatrol('старт, центр=', String(center), 'R=', R)

    const points = []
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      points.push(center.offset(Math.cos(a) * R, 0, Math.sin(a) * R))
    }

    patrolPromise = (async () => {
      try {
        try {
          await equipBestWeapon(bot, '[PATROL]')
        } catch (e) {
          logPatrol('equip weapon:', e?.message || e)
        }
        while (defendActive && currentDefendKind === 'patrol' && !patrolAbort) {
          if (await waitWhileCoreStateFlee(10000)) continue
          for (const p of points) {
            if (!defendActive || patrolAbort) break

            await waitUntilPathfinderFreeForDefend()

            const threatNear = findThreat(bot, bot.entity.position, 12, patrolExcludeOpts)
            if (threatNear) {
              logPatrol('угроза рядом с ботом, бой')
              await runCombatOnThreat(threatNear, '[PATROL]')
              await waitUntilCombatEnds()
            }

            await safeGoto(p.x, p.y, p.z, 2, '[PATROL]')

            if (bot.entity.position.distanceTo(center) > R * 2) {
              logPatrol('leash: возврат к центру (>', R * 2, ')')
              await safeGoto(center.x, center.y, center.z, 2.5, '[PATROL]')
            }

            const threat2 = findThreat(bot, bot.entity.position, 12, patrolExcludeOpts)
            if (threat2) {
              await runCombatOnThreat(threat2, '[PATROL]')
              await waitUntilCombatEnds()
              if (bot.entity.position.distanceTo(center) > R * 2) {
                await safeGoto(center.x, center.y, center.z, 2.5, '[PATROL]')
              }
            }
          }
        }
      } finally {
        defendActive = false
        currentDefendKind = null
        logPatrol('цикл завершён')
      }
    })()

    return { ok: true, mode: 'patrol', center: String(center), radius: R }
  }

  async function defendPoint (opts = {}) {
    stopAllDefend({ silent: true })
    cancelNavModes()
    defendActive = true
    currentDefendKind = 'point'
    pointAbort = false

    let ax = opts.x
    let ay = opts.y
    let az = opts.z
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) {
      ax = bot.entity.position.x
      ay = bot.entity.position.y
      az = bot.entity.position.z
    }
    const anchor = new Vec3(ax, ay, az)

    const radius = Math.min(24, Math.max(4, Number(opts.radius) || 10))
    const leash = radius * 1.5
    const pointExclude = opts.exclude_players || opts.excludeUsernames
    const pointExcludeOpts =
      Array.isArray(pointExclude) && pointExclude.length ? { excludeUsernames: pointExclude } : {}
    const wantPatrol =
      opts.patrol === true ||
      opts.patrol === 1 ||
      String(opts.patrol || '').toLowerCase() === 'true'
    const enablePatrol = !!(wantPatrol && config.defendPatrolEnabled)
    if (wantPatrol && !config.defendPatrolEnabled) {
      logPoint('patrol legs ignored: PATROL disabled (set PATROL_ENABLED=1).')
    }

    logPoint('старт якорь=', ax, ay, az, 'r=', radius, 'leash=', leash, enablePatrol ? 'patrol=on' : 'patrol=off')

    pointPromise = (async () => {
      let pointPatrolHold = 0
      let pointPatrolHoldMax = 2 + Math.floor(Math.random() * 3)
      try {
        await safeGoto(ax, ay, az, 1.5, '[DEFEND POINT]')
        while (defendActive && currentDefendKind === 'point' && !pointAbort) {
          if (await waitWhileCoreStateFlee(10000)) continue
          await waitUntilPathfinderFreeForDefend()
          const threat = findThreat(bot, anchor, radius, pointExcludeOpts)
          if (threat) {
            pointPatrolHold = 0
            pointPatrolHoldMax = 2 + Math.floor(Math.random() * 3)
            logPoint('угроза:', threat.name || threat.username)
            await runCombatOnThreat(threat, '[DEFEND POINT]')
            await waitUntilCombatEnds()
          }

          const distA = bot.entity.position.distanceTo(anchor)
          if (distA > leash) {
            logPoint('возврат: отбросили дальше leash')
            await safeGoto(ax, ay, az, 1.5, '[DEFEND POINT]')
            pointPatrolHold = 0
            pointPatrolHoldMax = 2 + Math.floor(Math.random() * 3)
            continue
          }

          if (!enablePatrol) {
            await sleep(350)
            continue
          }

          pointPatrolHold++
          if (pointPatrolHold < pointPatrolHoldMax) {
            await sleep(350)
            continue
          }

          const tPre = findThreat(bot, anchor, radius, pointExcludeOpts)
          if (tPre) {
            pointPatrolHold = 0
            continue
          }

          pointPatrolHold = 0
          pointPatrolHoldMax = 2 + Math.floor(Math.random() * 4)

          const prDefault = Math.min(12, Math.max(4, radius * 0.72))
          const prRaw = Number(opts.patrol_radius)
          const prCap = Math.max(4, Math.min(leash - 2, radius + 4))
          const pr = Math.min(
            prCap,
            Math.max(4, Number.isFinite(prRaw) && prRaw > 0 ? prRaw : prDefault)
          )
          const idx = Math.floor(Math.random() * 8)
          const ang = (idx / 8) * Math.PI * 2
          const px = anchor.x + Math.cos(ang) * pr
          const pz = anchor.z + Math.sin(ang) * pr
          const py = anchor.y
          logPoint('patrol leg pr=', pr.toFixed(1), '->', px.toFixed(1), py.toFixed(1), pz.toFixed(1))
          await safeGoto(px, py, pz, 2, '[DEFEND POINT]')
        }
      } finally {
        defendActive = false
        currentDefendKind = null
        logPoint('цикл завершён')
      }
    })()

    return { ok: true, mode: 'defendPoint', anchor: { x: ax, y: ay, z: az }, radius, patrol: enablePatrol }
  }

  async function defendEntity (opts = {}) {
    const username = opts.player_name || opts.playerName || opts.username || opts.target
    if (!username || typeof username !== 'string') {
      logEntity('ошибка: нужен player_name / playerName')
      return { ok: false, error: 'need_player_name' }
    }

    stopAllDefend({ silent: true })
    cancelNavModes()
    defendActive = true
    currentDefendKind = 'entity'
    entityAbort = false

    const followRange = Math.min(6, Math.max(2, Number(opts.follow_range) || 3))
    const threatRadius = Math.min(16, Math.max(4, Number(opts.threat_radius) || 6))
    const maxChase = Math.min(40, Math.max(8, Number(opts.max_chase) || 20))

    logEntity('старт охрана игрока', username, 'follow=', followRange, 'threatR=', threatRadius)

    entityPromise = (async () => {
      try {
        while (defendActive && currentDefendKind === 'entity' && !entityAbort) {
          if (await waitWhileCoreStateFlee(10000)) continue
          await waitUntilPathfinderFreeForDefend()
          const ownerEnt = resolvePlayerEntity(username)
          if (!ownerEnt?.position) {
            logEntity('владелец не в зоне — пауза')
            await sleep(500)
            continue
          }

          const threat = findThreat(bot, ownerEnt.position, threatRadius, {
            excludeUsername: username
          })
          const coreState = typeof getCoreState === 'function' ? getCoreState() : null
          if (threat && isCombatSessionActive() === false && coreState !== CoreStates.FLEE) {
            if (threat.position.distanceTo(ownerEnt.position) <= maxChase) {
              logEntity('угроза у владельца:', threat.name || threat.username)
              await runCombatOnThreat(threat, '[DEFEND ENTITY]')
              await waitUntilCombatEnds()
            }
          }

          if (bot.entity.position.distanceTo(ownerEnt.position) > maxChase) {
            logEntity('слишком далеко от владельца — подтягиваюсь')
            await safeGoto(ownerEnt.position.x, ownerEnt.position.y, ownerEnt.position.z, followRange + 0.5, '[DEFEND ENTITY]')
          } else {
            await waitUntilPathfinderFreeForDefend()
            if (pathfinderYieldedToCombat()) {
              await sleep(200)
              continue
            }
            try {
              prepareDefendPathfinderSafety()
              await bot.pathfinder.goto(new GoalFollow(ownerEnt, followRange))
            } catch (e) {
              logEntity('GoalFollow:', e?.message || e)
            }
          }
          await sleep(200)
        }
      } finally {
        defendActive = false
        currentDefendKind = null
        logEntity('цикл завершён')
      }
    })()

    return { ok: true, mode: 'defendEntity', username, followRange, threatRadius }
  }

  return {
    patrolMode,
    defendPoint,
    defendEntity,
    stopAllDefend,
    tickChatGuard,
    findThreat,
    isDefendActive: () => defendActive
  }
}
