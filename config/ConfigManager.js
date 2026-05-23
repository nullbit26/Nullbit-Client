'use strict'

const path = require('path')
const fs = require('fs')
const dotenv = require('dotenv')

let loaded = false

/**
 * Try to load config.json from the same directory as the executable (pkg),
 * then from the project root. Maps fields to process.env so the rest of the
 * codebase (config.js) works unchanged. .env is loaded afterwards and takes
 * priority (developer override).
 */
function loadConfigJson (baseDir) {
  const candidates = [
    path.join(baseDir, 'config.json'),
    path.join(__dirname, '..', 'config.json')
  ]
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (e) {
      throw new Error(`[ConfigManager] Failed to parse ${filePath}: ${e.message}`)
    }
    const set = (key, val) => {
      if (val != null && val !== '' && process.env[key] == null) {
        process.env[key] = String(val)
      }
    }
    // Support both structures:
    //   release/launcher: { minecraft: { host, port, version, auth, username, password }, bot: { allowed_user, server_password } }
    //   legacy:           { server: { host, port, version }, auth, bot: { username, allowed_user, server_password } }
    const mc = raw.minecraft || {}
    const s  = raw.server    || {}
    const b  = raw.bot       || {}
    set('MC_HOST',      mc.host      || s.host)
    set('MC_PORT',      mc.port      || s.port)
    set('MC_VERSION',   mc.version   || s.version)
    set('MC_AUTH',      mc.auth      || raw.auth)
    set('MC_USERNAME',  mc.username  || b.username)
    set('MC_PASSWORD',  mc.password  || b.server_password)
    set('ALLOWED_USERS', b.allowed_user)

    // Neural config (launcher NEURAL tab → config.json neural section)
    const n = raw.neural || {}
    set('COMBAT_FLEE_CRITICAL_HP',              n.combatFleeCriticalHp)
    set('COMBAT_FLEE_SAFE_HP',                  n.combatFleeSafeHp)
    set('COMBAT_FLEE_RETREAT_SCORE_THRESHOLD',  n.combatFleeRetreatScoreThreshold)
    set('COMBAT_FLEE_NAV_DISTANCE',             n.combatFleeNavDistance)
    set('COMBAT_FLEE_IMMEDIATE_DANGER_BLOCKS',  n.combatFleeImmediateDangerBlocks)
    set('COMBAT_FLEE_RETREAT_HP_WEIGHT',        n.combatFleeRetreatHpWeight)
    set('COMBAT_FLEE_RETREAT_PRESSURE_WEIGHT',  n.combatFleeRetreatPressureWeight)
    set('PVP_ATTACK_COOLDOWN',                  n.pvpAttackCooldown)
    set('PVP_IDEAL_DISTANCE',                   n.pvpIdealDistance)
    set('PVP_KITE_HP_THRESHOLD',                n.pvpKiteHpThreshold)
    set('PVP_ENGAGE_SAFE_HP',                   n.pvpEngageSafeHp)
    set('PATH_THINK_TIMEOUT_MS',                n.pathThinkTimeoutMs)
    set('STUCK_CHECK_TICKS',                    n.stuckCheckTicks)
    set('FOLLOW_DISTANCE',                      n.followDistance)
    set('GUARD_MOB_DISTANCE',                   n.guardMobDistance)
    set('BRANCH_LENGTH',                        n.branchLength)
    set('MAX_BRANCHES',                         n.maxBranches)
    set('ORE_SCAN_RADIUS',                      n.oreScanRadius)
    set('TORCH_INTERVAL',                       n.torchInterval)
    set('AI_COOLDOWN_MS',                       n.aiCooldownMs)
    set('AI_TIMEOUT_MS',                        n.aiTimeoutMs)
    set('OPENAI_THREAD_RESET_AFTER_MESSAGES',   n.openAiThreadResetAfterMessages)
    set('GATHER_GUARD_SURVIVAL_THREAT_COUNT',   n.gatherGuardSurvivalThreatCount)
    set('GATHER_GUARD_SURVIVAL_LOW_HP',         n.gatherGuardSurvivalLowHp)
    set('GATHER_GUARD_FIGHT_MAX_THREATS',       n.gatherGuardFightMaxThreats)
    set('GATHER_GUARD_FIGHT_MIN_HP_RATIO',      n.gatherGuardFightMinHpRatio)
    set('GATHER_GUARD_FIGHT_MAX_ENGAGE_DIST',   n.gatherGuardFightMaxEngageDist)

    return filePath
  }
  return null
}

/**
 * Load config.json (user-facing), then `.env` (developer override), then validate.
 * Call from `index.js` before any module reads `process.env`.
 */
function load (options = {}) {
  if (loaded) return

  // 1. .env — developer override (highest priority; dotenv skips vars already in process.env)
  const envPath = options.envPath != null ? String(options.envPath) : path.join(__dirname, '..', '.env')
  dotenv.config({ path: envPath })

  // 2. config.json — user-facing settings (fills only what .env did not set)
  const baseDir = options.baseDir != null
    ? String(options.baseDir)
    : (typeof process.pkg !== 'undefined'
      ? path.dirname(process.execPath)   // pkg exe: same folder as .exe
      : path.join(__dirname, '..')       // dev: project root
    )
  loadConfigJson(baseDir)

  validate()
  loaded = true
}

function validate () {
  const openai = String(process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY || '').trim()
  const assistant = String(process.env.ASSISTANT_ID || process.env.OPENAI_ASSISTANT_ID || '').trim()
  const strict = process.env.STRICT_AI_ENV === '1' || process.env.RELEASE_STRICT === '1'

  if (assistant && !openai) {
    throw new Error(
      '[ConfigManager] ASSISTANT_ID (or OPENAI_ASSISTANT_ID) is set but OPENAI_API_KEY (or CHATGPT_API_KEY) is missing.'
    )
  }

  if (strict) {
    if (!openai) {
      throw new Error('[ConfigManager] STRICT_AI_ENV / RELEASE_STRICT: OPENAI_API_KEY (or CHATGPT_API_KEY) is required.')
    }
    if (!assistant) {
      throw new Error('[ConfigManager] STRICT_AI_ENV / RELEASE_STRICT: ASSISTANT_ID (or OPENAI_ASSISTANT_ID) is required.')
    }
  }
}

function assertLoaded () {
  if (!loaded) {
    throw new Error('[ConfigManager] load() was not called before reading secured config. Import index entry or call ConfigManager.load() first.')
  }
}

/**
 * Map neural section from config.json directly onto a live config object.
 * Safe to call at any time — only overwrites defined numeric values.
 * @param {object} neural  raw.neural from config.json
 * @param {object} target  live config object (e.g. require('./config.js'))
 */
function applyNeuralOverrides (neural, target) {
  if (!neural || typeof neural !== 'object') return
  const num = (v, min, max) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return undefined
    if (min !== undefined && n < min) return min
    if (max !== undefined && n > max) return max
    return n
  }
  const set = (key, v) => { if (v !== undefined) target[key] = v }

  set('combatFleeCriticalHp',            num(neural.combatFleeCriticalHp,            1,   20))
  set('combatFleeSafeHp',                num(neural.combatFleeSafeHp,                1,   20))
  set('combatFleeRetreatScoreThreshold', num(neural.combatFleeRetreatScoreThreshold, 0.4, 4))
  set('combatFleeNavDistance',           num(neural.combatFleeNavDistance,           5,   40))
  set('combatFleeImmediateDangerBlocks', num(neural.combatFleeImmediateDangerBlocks, 4,   20))
  set('combatFleeRetreatHpWeight',       num(neural.combatFleeRetreatHpWeight,       0.2, 3))
  set('combatFleeRetreatPressureWeight', num(neural.combatFleeRetreatPressureWeight, 0.2, 3))
  set('pvpAttackCooldown',               num(neural.pvpAttackCooldown,               400, 1000))
  set('pvpIdealDistance',                num(neural.pvpIdealDistance,                2,   4))
  set('pvpKiteHpThreshold',              num(neural.pvpKiteHpThreshold,              2,   14))
  set('pvpEngageSafeHp',                 num(neural.pvpEngageSafeHp,                 10,  20))
  set('pathThinkTimeoutMs',              num(neural.pathThinkTimeoutMs,              5000, 60000))
  set('stuckCheckTicks',                 num(neural.stuckCheckTicks,                 5,   30))
  set('followDistance',                  num(neural.followDistance,                  1,   10))
  set('guardMobDistance',                num(neural.guardMobDistance,                4,   20))
  set('aiCooldownMs',                    num(neural.aiCooldownMs,                    1000, 15000))
  set('aiTimeoutMs',                     num(neural.aiTimeoutMs,                     3000, 30000))
  set('openAiThreadResetAfterMessages',  num(neural.openAiThreadResetAfterMessages,  0,   100))
  set('gatherGuardSurvivalThreatCount',  num(neural.gatherGuardSurvivalThreatCount,  2,   8))
  set('gatherGuardSurvivalLowHp',        num(neural.gatherGuardSurvivalLowHp,        2,   16))
  set('gatherGuardFightMaxThreats',      num(neural.gatherGuardFightMaxThreats,      1,   5))
  set('gatherGuardFightMinHpRatio',      num(neural.gatherGuardFightMinHpRatio,      0.3, 1))
  set('gatherGuardFightMaxEngageDist',   num(neural.gatherGuardFightMaxEngageDist,   6,   24))
}

/**
 * Watch config.json for changes and hot-reload the neural section into a live config object.
 * Debounced 300ms to avoid double-fire on some editors/OS.
 * @param {string} configPath  absolute path to config.json
 * @param {object} liveConfig  the live config object to patch
 * @param {object} [log]       optional logger with .info()
 * @returns {fs.FSWatcher}
 */
function watchNeural (configPath, liveConfig, log) {
  let debounce = null
  const watcher = fs.watch(configPath, () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        applyNeuralOverrides(raw.neural || {}, liveConfig)
        if (log && log.info) log.info('[ConfigManager] Neural config reloaded from config.json')
        else console.log('[ConfigManager] Neural config reloaded from config.json')
      } catch (e) {
        if (log && log.warn) log.warn('[ConfigManager] Neural reload failed:', e.message)
        else console.warn('[ConfigManager] Neural reload failed:', e.message)
      }
    }, 300)
  })
  return watcher
}

module.exports = {
  load,
  validate,
  assertLoaded,
  applyNeuralOverrides,
  watchNeural,
  get loaded () {
    return loaded
  }
}
