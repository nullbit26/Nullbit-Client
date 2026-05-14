'use strict'

const { HOSTILE_MOB } = require('../features/getEnvironment')
const { AwarenessEvents } = require('../core/EventRegistry')

/** ~45 с между фоновыми осмотрами (случайно 40–60). */
const BG_MIN_MS = 40 * 1000
const BG_MAX_MS = 60 * 1000
/** Быстрая проверка опасности / лута. */
const FAST_SCAN_MS = 1200
/** Обычные автономные фразы через ИИ — не чаще ~2.5 мин. */
const AUTONOMOUS_COOLDOWN_MS = 150 * 1000
/** Повтор «крипер рядом» не чаще. */
const CREEPER_WARN_GAP_MS = 14 * 1000
/** Общий анти-спам для прочих предупреждений по мобам. */
const HOSTILE_WARN_GAP_MS = 10 * 1000
/** Ирония после урона игрока. */
const HURT_COMMENT_GAP_MS = 28 * 1000
/** Жадный комментарий к руде через ИИ. */
const PREMIUM_LOOT_GAP_MS = 75 * 1000

const DARK_WARN_GAP_MS = 90 * 1000 // не чаще 90 секунд
const DARK_LIGHT_THRESHOLD = 7 // уровень освещения <= 7 = темно

const DARK_LINES = [
  'Тут темновато... мне, сука, стрёмно.',
  'Светлячков не хватает. Чувствую ебать какую-то вонь.',
  'Слишком тихо и темно. Что-то здесь не так.',
  'В такой темноте даже боты нихуя не видят. Осторожнее.',
  'Слышишь? В темноте кто-то шуршит...'
]

const NIGHT_LINES = [
  'Ночь. Самое время для непрошенных гостей.',
  'Луна светит, зомби бродят. Классика, епта.',
  'Темнеет. Советую держаться поближе.',
  'Ночью тут оживлённо... эм, ну, не в том смысле...'
]

const DANGER_HOSTILE_DIST = 8
const CREEPER_SPECIAL_DIST = 8

/** Assume ~20 physics ticks per second (50 ms / tick) for scan cadence. */
const MS_PER_PHYSICS_TICK = 50
const FAST_INTERVAL_TICKS = Math.max(1, Math.ceil(FAST_SCAN_MS / MS_PER_PHYSICS_TICK))
const BG_CHECK_INTERVAL_TICKS = 20

const TASK_FAST = 'awareness_fast_scan'
const TASK_BG = 'awareness_background_gate'

const CREEPER_LINES = [
  'Сзади, крипер! Отходи!',
  'Крипер близко — развернись!',
  'Тсс, шипение. Крипер в паре метров!'
]

const HOSTILE_LINES = [
  'Вражина рядом, будь начеку!',
  'Моб у нас под боком!',
  'Осторожно, зло уже близко!'
]

const HURT_TAUNTS = [
  'Грация картошки, мяу!',
  'Смотри под ноги, герой!',
  'Ой-ой, кому-то больно?',
  'Так держать, акробатика топ!',
  'Земля твёрже, чем ты думал?'
]

const DEATH_LINES = [
  'Респавн неизбежен. В следующий раз — меньше героизма, больше мозгов, мяу.',
  'Ну и ну. Великий воин пал. Я почти плакала. Почти.'
]

function sanitizeVoiceText (input) {
  return Buffer.from(String(input ?? ''), 'utf8')
    .toString('utf8')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s.,!?;:'"()\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
}

function randomFrom (arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function listHostilesWithinLegacy (bot, maxDist) {
  if (!bot.entity?.position) return []
  const pos = bot.entity.position
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e === bot.entity) continue
    if (e.type === 'player') continue
    const n = (e.name || '').toLowerCase()
    if (!HOSTILE_MOB.has(n)) continue
    const d = pos.distanceTo(e.position)
    if (d > maxDist) continue
    const id = typeof e.id === 'number' ? e.id : Number(e.id)
    out.push({ entity: e, d, name: n, id: Number.isFinite(id) ? id : -1 })
  }
  out.sort((a, b) => a.d - b.d)
  return out
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {number} maxDist
 */
function listHostilesWithin (bot, maxDist) {
  const pi = bot.partyIFF
  if (pi && typeof pi.listThreatsWithin === 'function') {
    const rows = pi.listThreatsWithin(maxDist)
    return rows.map((r) => ({ entity: r.entity, d: r.d, name: r.name, id: r.id }))
  }
  return listHostilesWithinLegacy(bot, maxDist)
}

function pickNearestHostile (bot, maxDist) {
  const list = listHostilesWithin(bot, maxDist)
  if (!list.length) return null
  const h = list[0]
  return { entity: h.entity, d: h.d, name: h.name }
}

function snapshotSignature (snap) {
  if (!snap.ok) return 'bad'
  const pl = snap.players
    .map((p) => `${p.username}:${Math.round(p.dist / 4)}:${p.trashHand ? 1 : 0}`)
    .sort()
    .join('|')
  return [
    pl,
    snap.hostileMinDist != null ? Math.round(snap.hostileMinDist / 4) : 'x',
    snap.creeperMinDist != null ? Math.round(snap.creeperMinDist / 4) : 'x',
    snap.premiumOreVisible ? 'ore1' : 'ore0'
  ].join(';')
}

function isSignificantChange (prevSnap, nextSnap, prevSig, nextSig) {
  if (!prevSnap?.ok || !nextSnap?.ok) return nextSnap?.ok
  if (prevSig !== nextSig) {
    if (nextSnap.players.length !== prevSnap.players.length) return true
    const prevP = new Set(prevSnap.players.map((p) => p.username))
    for (const p of nextSnap.players) {
      if (!prevP.has(p.username)) return true
    }
    if (nextSnap.premiumOreVisible && !prevSnap.premiumOreVisible) return true
    const wasH = prevSnap.hostileMinDist ?? 999
    const nowH = nextSnap.hostileMinDist ?? 999
    if (nowH < wasH - 4 && nowH < 20) return true
    if ((prevSnap.creeperMinDist == null) !== (nextSnap.creeperMinDist == null)) return true
  }
  const trashNow = nextSnap.players.some((p) => p.trashHand)
  const trashPrev = prevSnap.players.some((p) => p.trashHand)
  if (trashNow && !trashPrev) return true
  return false
}

/**
 * Tick-driven awareness: updates `OperationalMemory` and emits `awareness:*` on the brain bus.
 *
 * @typedef {Object} AwarenessDeps
 * @property {import('../voice')} [voice]
 * @property {{ askAssistant: Function }} [ai]
 * @property {Function} [log]
 * @property {Function} scanEnvironment
 * @property {Function} getEnvironment
 * @property {() => string} [getAssistantBriefing]
 */

class AwarenessSystem {
  /**
   * @param {{ brain: import('../core/BotBrain').BotBrain } & AwarenessDeps} opts
   */
  constructor (opts) {
    if (!opts?.brain) throw new Error('[AwarenessSystem] opts.brain is required')
    const b = opts.brain

    /** @private @readonly */
    this._bot = b.bot
    /** @private @readonly */
    this._bus = b.eventBus
    /** @private @readonly */
    this._scheduler = b.scheduler
    /** @private @readonly */
    this._memory = b.memory

    /** @private */
    this._voice = opts.voice
    /** @private */
    this._ai = opts.ai
    /** @private */
    this._log = typeof opts.log === 'function' ? opts.log : (...a) => console.log(...a)
    /** @private */
    this._scanEnvironment = opts.scanEnvironment
    /** @private */
    this._getEnvironment = opts.getEnvironment
    /** @private */
    this._getAssistantBriefing = opts.getAssistantBriefing

    if (typeof this._scanEnvironment !== 'function') {
      throw new Error('[AwarenessSystem] scanEnvironment is required')
    }
    if (typeof this._getEnvironment !== 'function') {
      throw new Error('[AwarenessSystem] getEnvironment is required')
    }

    /** @private */
    this._lastAutonomousAt = 0
    /** @private */
    this._lastCreeperWarnAt = 0
    /** @private */
    this._lastHostileWarnAt = 0
    /** @private */
    this._lastHurtTauntAt = 0
    /** @private */
    this._lastPremiumLootAt = 0
    /** @private */
    this._lastDarkWarnAt = 0
    /** @private */
    this._prevScan = null
    /** @private */
    this._prevSig = ''
    /** @private */
    this._nextBackgroundDueAt = 0
    /** @private */
    this._backgroundBusy = false

    /** @private */
    this._wired = false
    /** @private */
    this._onEntityHurt = this._onEntityHurt.bind(this)
    /** @private */
    this._onEntityDead = this._onEntityDead.bind(this)
    /** @private */
    this._onEnd = this._onEnd.bind(this)
    /** @private */
    this._onSpawn = this._onSpawn.bind(this)
  }

  /** @private */
  _speak (txt) {
    const s = sanitizeVoiceText(txt)
    if (!s || !this._voice || typeof this._voice.speak !== 'function') return
    this._voice.speak(s).catch((e) => this._log('[awareness voice]', e.message))
  }

  /** @private */
  _scheduleFirstBackground () {
    this._nextBackgroundDueAt = Date.now() + BG_MIN_MS + Math.random() * (BG_MAX_MS - BG_MIN_MS)
  }

  /** @private */
  async _runBackgroundTick () {
    if (!this._bot.entity?.position) return
    const snap = this._scanEnvironment(this._bot)
    const sig = snapshotSignature(snap)
    if (!snap.ok) return

    this._memory.applyScanSnapshot(snap)

    if (this._prevScan === null) {
      this._prevScan = snap
      this._prevSig = sig
      return
    }

    const changed = isSignificantChange(this._prevScan, snap, this._prevSig, sig)
    this._prevScan = snap
    this._prevSig = sig

    const now = Date.now()
    if (!changed) return
    if (now - this._lastAutonomousAt < AUTONOMOUS_COOLDOWN_MS) return

    const env =
      typeof this._getAssistantBriefing === 'function'
        ? this._getAssistantBriefing()
        : typeof this._getEnvironment === 'function'
          ? this._getEnvironment(this._bot)
          : ''
    const trashHint = snap.players?.some((p) => p.trashHand)
      ? ' У игрока в руках похоже на мусор (земля/палки/булыжник) — можно язвительно подколоть «великого строителя» или «бомжа».'
      : ''
    const prompt =
      `Сводка окружения:\n${env}\n\n` +
      `Кратко 1–2 предложения по-русски, в голос: дерзко прокомментируй ситуацию как МИНИ КОШ.` +
      trashHint +
      ` Не обращайся к системе и не перечисляй координаты дословно — только живая реплика.`

    if (!this._ai || typeof this._ai.askAssistant !== 'function') return
    const reply = await this._ai.askAssistant(prompt, { spokeUsername: 'autonomous', autonomous: true })
    if (reply && typeof reply === 'string' && reply.length > 2) {
      this._lastAutonomousAt = Date.now()
      this._speak(reply)
    }
  }

  /** @private */
  async _checkFastTriggers () {
    if (!this._bot.entity?.position) return

    const hostiles = listHostilesWithin(this._bot, DANGER_HOSTILE_DIST)
    this._memory.setCurrentThreats(
      hostiles.map((h) => ({
        id: h.id,
        name: h.name,
        distance: h.d
      }))
    )

    const hostile = hostiles.length ? { entity: hostiles[0].entity, d: hostiles[0].d, name: hostiles[0].name } : null
    const now = Date.now()

    if (hostile) {
      const isCreeper = hostile.name === 'creeper' && hostile.d <= CREEPER_SPECIAL_DIST
      if (isCreeper) {
        if (now - this._lastCreeperWarnAt >= CREEPER_WARN_GAP_MS) {
          this._lastCreeperWarnAt = now
          const id = typeof hostile.entity?.id === 'number' ? hostile.entity.id : Number(hostile.entity?.id)
          this._bus.emit(AwarenessEvents.THREAT_DETECTED, {
            kind: 'creeper',
            name: hostile.name,
            distance: hostile.d,
            at: now,
            entityId: Number.isFinite(id) ? id : undefined
          })
          this._speak(randomFrom(CREEPER_LINES))
          return
        }
      } else if (hostile.d <= DANGER_HOSTILE_DIST - 0.5 && now - this._lastHostileWarnAt >= HOSTILE_WARN_GAP_MS) {
        this._lastHostileWarnAt = now
        const id = typeof hostile.entity?.id === 'number' ? hostile.entity.id : Number(hostile.entity?.id)
        this._bus.emit(AwarenessEvents.THREAT_DETECTED, {
          kind: 'hostile',
          name: hostile.name,
          distance: hostile.d,
          at: now,
          entityId: Number.isFinite(id) ? id : undefined
        })
        this._speak(randomFrom(HOSTILE_LINES))
        return
      }
    }

    const lightLevel = this._bot.blockAt(this._bot.entity.position)?.light ??
      this._bot.entity?.metadata?.[6] ?? 15
    const isNight = (this._bot.time?.timeOfDay ?? 0) > 13000 &&
      (this._bot.time?.timeOfDay ?? 0) < 23000
    const isDark = lightLevel <= DARK_LIGHT_THRESHOLD

    if ((isDark || isNight) && !hostile && now - this._lastDarkWarnAt >= DARK_WARN_GAP_MS) {
      this._lastDarkWarnAt = now
      const lines = isNight && isDark
        ? [...DARK_LINES, ...NIGHT_LINES]
        : isDark ? DARK_LINES : NIGHT_LINES
      this._speak(randomFrom(lines))
    }

    const snap = this._scanEnvironment(this._bot)
    if (!snap.ok || !snap.premiumOreVisible) return
    if (now - this._lastPremiumLootAt < PREMIUM_LOOT_GAP_MS) return

    this._memory.applyScanSnapshot(snap)

    this._lastPremiumLootAt = now
    const oreHint = snap.premiumOreName ? ` (${snap.premiumOreName}, ~${snap.premiumOreDist}м)` : ''
    this._bus.emit(AwarenessEvents.PREMIUM_LOOT, {
      premiumOreName: snap.premiumOreName,
      premiumOreDist: snap.premiumOreDist,
      at: now
    })
    if (!this._ai || typeof this._ai.askAssistant !== 'function') return
    const reply = await this._ai.askAssistant(
      `Ты только что заметил жирный лут в поле зрения${oreHint}. Одна или две фразы по-русски: жадность, восторг, подъязык как МИНИ КОШ. Без списков.`,
      { spokeUsername: 'autonomous', autonomous: true }
    )
    if (reply && typeof reply === 'string') {
      this._lastAutonomousAt = Date.now()
      this._speak(reply)
    }
  }

  /** @private @param {any} entity @param {any} [source] */
  _onEntityHurt (entity, source) {
    if (source && this._bot.partyIFF && typeof this._bot.partyIFF.markAggroFromDamage === 'function') {
      try {
        this._bot.partyIFF.markAggroFromDamage(entity, source)
      } catch (_) {}
    }

    if (!entity || entity === this._bot.entity) return
    if (entity.type !== 'player' || !entity.username) return
    if (entity.username === this._bot.username) return
    if (!this._bot.entity?.position || !entity.position) return
    const d = this._bot.entity.position.distanceTo(entity.position)
    if (d > 24) return
    const now = Date.now()
    if (now - this._lastHurtTauntAt < HURT_COMMENT_GAP_MS) return
    this._lastHurtTauntAt = now

    this._memory.setLastAttacker({ username: entity.username, distance: d, at: now })
    this._bus.emit(AwarenessEvents.DAMAGED, {
      username: entity.username,
      distance: d,
      at: now
    })

    if (!this._ai || typeof this._ai.askAssistant !== 'function') {
      this._speak(randomFrom(HURT_TAUNTS))
      return
    }
    void (async () => {
      const reply = await this._ai.askAssistant(
        `Игрок ${entity.username} только что получил урон рядом с тобой (в шутку подколи его как МИНИ КОШ — одна короткая фраза, можно как «грация картошки»).`,
        { spokeUsername: entity.username || 'player', autonomous: true }
      )
      if (reply && typeof reply === 'string' && reply.length > 2) {
        this._speak(reply)
      } else {
        this._speak(randomFrom(HURT_TAUNTS))
      }
    })()
  }

  /** @private */
  _onEntityDead (entity) {
    if (!entity) return
    // Чистим мёртвого моба из памяти угроз
    if (entity.type !== 'player') {
      const id = typeof entity.id === 'number' ? entity.id : Number(entity.id)
      if (Number.isFinite(id)) {
        const threats = this._memory.getCurrentThreats().filter((t) => t.id !== id)
        this._memory.setCurrentThreats(threats)
      }
      return
    }
    if (!entity.username) return
    if (entity.username === this._bot.username) return
    if (!this._bot.entity?.position || !entity.position) return
    const d = this._bot.entity.position.distanceTo(entity.position)
    if (d > 48) return
    const at = Date.now()
    this._bus.emit(AwarenessEvents.PLAYER_DEATH_NEARBY, {
      username: entity.username,
      distance: d,
      at
    })
    this._speak(randomFrom(DEATH_LINES))
  }

  /** @private */
  _onEnd () {
    this.destroy('bot_end')
  }

  /** @private */
  _onSpawn () {
    try {
      this._startLoops()
    } catch (e) {
      this._log('[awareness] start failed:', e.message)
    }
  }

  /** @private */
  _startLoops () {
    this._scheduler.unregister(TASK_FAST)
    this._scheduler.unregister(TASK_BG)
    this._scheduler.registerPeriodic(
      FAST_INTERVAL_TICKS,
      () => {
        void this._checkFastTriggers()
      },
      { id: TASK_FAST }
    )
    this._scheduleFirstBackground()
    this._scheduler.registerPeriodic(
      BG_CHECK_INTERVAL_TICKS,
      () => {
        if (this._backgroundBusy || Date.now() < this._nextBackgroundDueAt) return
        this._backgroundBusy = true
        void this._runBackgroundTick()
          .catch((e) => this._log('[awareness bg]', e instanceof Error ? e.message : String(e)))
          .finally(() => {
            this._backgroundBusy = false
            this._nextBackgroundDueAt = Date.now() + BG_MIN_MS + Math.random() * (BG_MAX_MS - BG_MIN_MS)
          })
      },
      { id: TASK_BG }
    )
  }

  init () {
    if (this._wired) return
    this._wired = true

    this._bot.on('entityHurt', this._onEntityHurt)
    this._bot.on('entityDead', this._onEntityDead)
    this._bot.on('end', this._onEnd)

    if (this._bot.entity?.position) {
      this._onSpawn()
    } else {
      this._bot.once('spawn', this._onSpawn)
    }
  }

  /**
   * @param {string} [reason]
   */
  destroy (reason) {
    if (!this._wired) return
    this._wired = false

    this._scheduler.unregister(TASK_FAST)
    this._scheduler.unregister(TASK_BG)

    this._bot.removeListener('entityHurt', this._onEntityHurt)
    this._bot.removeListener('entityDead', this._onEntityDead)
    this._bot.removeListener('end', this._onEnd)
    this._bot.removeListener('spawn', this._onSpawn)

    this._memory.clear()
    if (reason != null && String(reason)) {
      this._log('[awareness] stopped', String(reason))
    }
  }
}

module.exports = { AwarenessSystem, pickNearestHostile, listHostilesWithin }
