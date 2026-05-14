// =============================================================================
// attackEntity v2.0 — ближний/дальний бой для Mineflayer 1.21.x
// Phase 2: CombatSession — тик → planIntents → исполнение; cleanup + clearControlStates.
// =============================================================================

const { goals } = require('mineflayer-pathfinder')
const { GoalFollow, GoalBlock } = goals
const config = require('./config')
const {
  WEAPON_PRIORITY,
  equipBestArmor,
  equipBestWeapon,
  equipShield,
  pickBestBow
} = require('./features/combatEquipment')

const { CFG } = require('./combat/session/constants')
const { distanceTo } = require('./combat/session/geometry')
const {
  getCombatSessionActive,
  tryEnterCombatExclusive,
  releaseCombatExclusive
} = require('./combat/session/sessionFlags')
const { combatSessionCleanup } = require('./combat/session/combatSessionCleanup')
const { CombatSession } = require('./combat/session/CombatSession')

let currentCombatSession = null

let voiceQueue = []
let voiceBusy = false

async function queueVoice (voice, text) {
  if (!voice || typeof voice.speak !== 'function') return
  if (voiceQueue.length >= 2) voiceQueue = voiceQueue.slice(-1)
  voiceQueue.push(text)
  if (voiceBusy) return
  voiceBusy = true
  while (voiceQueue.length > 0) {
    const next = voiceQueue.shift()
    try {
      await voice.speak(next)
    } catch (e) {
      console.error('[TTS]', e.message)
    }
  }
  voiceBusy = false
}

function selectBestTarget (bot, entityName) {
  const nm = entityName.toLowerCase()
  const candidates = Object.values(bot.entities).filter((e) => {
    if (!e || e === bot.entity || e.id === bot.entity?.id) return false
    return (e.name || e.username || '').toLowerCase() === nm
  })
  if (!candidates.length) return null
  return candidates.sort((a, b) => distanceTo(bot, a) - distanceTo(bot, b))[0]
}

function resolveCombatTarget (bot, entityName, entityId) {
  if (entityId != null && bot.entities && bot.entities[entityId]) {
    const ent = bot.entities[entityId]
    if (ent && ent !== bot.entity && ent.id !== bot.entity?.id) return ent
  }
  return bot.players[entityName]?.entity ?? selectBestTarget(bot, entityName)
}

function ceasePvpCombat (bot) {
  try {
    const s = currentCombatSession
    if (s) {
      s.dispose(bot, { silent: true })
    } else {
      combatSessionCleanup(bot)
    }
  } finally {
    releaseCombatExclusive()
  }
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ speak?: Function } | null} voice
 * @param {{ silent?: boolean }} [opts]
 */
async function stopAttack (bot, voice, opts = {}) {
  ceasePvpCombat(bot)
  if (!opts.silent) {
    await queueVoice(voice, 'Атака остановлена.')
  }
}

async function attackEntity (bot, voice, args) {
  let { entityName, strategy = 'aggressive', entityId } = args

  if (!tryEnterCombatExclusive()) {
    return { success: false, reason: 'already_fighting' }
  }

  const speak = typeof voice?.speak === 'function' ? (t) => queueVoice(voice, t) : async () => {}

  const releaseSlot = () => {
    releaseCombatExclusive()
    combatSessionCleanup(bot)
  }

  if (bot.partyIFF && bot.partyIFF.isPartyUsername(entityName)) {
    await speak(`Отказываюсь атаковать ${entityName} — в пати.`)
    releaseSlot()
    return { success: false, reason: 'party_member' }
  }

  const selfName = bot.username?.toLowerCase?.() ?? ''
  if (selfName && String(entityName || '').toLowerCase() === selfName && entityId == null) {
    await speak('Не буду нападать на самого себя.')
    console.warn('[PVP] Отказ: цель совпадает с ником бота')
    releaseSlot()
    return { success: false, reason: 'self_target' }
  }

  let target = resolveCombatTarget(bot, entityName, entityId)
  if (strategy === 'aggressive' || strategy === 'defensive') {
    const hasMelee = bot.inventory.items().some((i) =>
      WEAPON_PRIORITY.some((w) => i.name.includes(w.key))
    )
    const bow = pickBestBow(bot)
    const arrows = bot.inventory.items().find((i) =>
      i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow'
    )
    if (!hasMelee && bow && arrows) {
      strategy = 'archer'
      console.log('[PVP] Авто: нет меча, есть лук → стратегия archer')
    }
  }
  if (!target || target.id === bot.entity.id) {
    if (target?.id === bot.entity.id) {
      console.warn('[PVP] Отказ: entity цели — сам бот')
    }
    if (!target) await speak(`Цель ${entityName} не найдена.`)
    else await speak('Это же я сам. Атака отменена.')
    releaseSlot()
    return { success: false, reason: target ? 'self_entity' : 'target_not_found' }
  }

  try {
    await equipBestArmor(bot)
    await equipBestWeapon(bot)
    let hasShield = await equipShield(bot)

    const nearbyItems = Object.values(bot.entities).filter(
      (e) => e.name === 'item' && bot.entity.position.distanceTo(e.position) < 3
    )
    for (const item of nearbyItems) {
      try {
        await bot.pathfinder.goto(
          new GoalBlock(Math.floor(item.position.x), Math.floor(item.position.y), Math.floor(item.position.z))
        )
      } catch (_) {}
    }

    await equipBestArmor(bot)
    await equipBestWeapon(bot)
    hasShield = await equipShield(bot)

    if (strategy === 'archer') {
      const bowI = pickBestBow(bot)
      const arrI = bot.inventory.items().find(
        (i) => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow'
      )
      if (bowI && arrI) await bot.equip(bowI, 'hand')
    }

    await speak(`Принято, ликвидирую цель ${entityName}!`)
    console.log(`[PVP] Бой с ${entityName} | стратегия: ${strategy}`)

    const session = new CombatSession(
      bot,
      voice,
      { entityName, entityId, strategy, target },
      {
        resolveCombatTarget,
        onRequestDefensiveRestart: async () => {
          await attackEntity(bot, voice, { entityName, entityId, strategy: 'defensive' })
        },
        clearParentRef: (s) => {
          if (currentCombatSession === s) currentCombatSession = null
        }
      }
    )
    session.hasShield = hasShield

    session.wirePathfinderMovements()

    if (strategy === 'stealth') {
      bot.setControlState('sneak', true)
      bot.setControlState('sprint', false)
      try {
        await bot.pathfinder.goto(new GoalFollow(target, 1.5))
      } catch (_) {}
      bot.setControlState('sneak', false)
      await speak('Атакую из-за спины!')
    }

    currentCombatSession = session
    session.start((t) => queueVoice(voice, t))

    return { success: true, target: entityName, strategy }
  } catch (e) {
    console.error('[PVP] сбой до/во время старта боя:', e?.message || e)
    try {
      await speak('Сбой боя: ' + String(e?.message || e).slice(0, 80))
    } catch (_) {}
    ceasePvpCombat(bot)
    return { success: false, reason: 'exception', message: String(e?.message || e) }
  }
}

function isCombatSessionActive () {
  return getCombatSessionActive()
}

function isCombatFriend (_name) {
  return false
}

module.exports = { attackEntity, stopAttack, CFG, isCombatSessionActive, isCombatFriend }
