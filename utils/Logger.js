'use strict'

const { REGISTERED_EVENT_NAMES, CoreEvents, NavEvents } = require('../core/EventRegistry')

const LEVEL_RANK = Object.freeze({ debug: 0, info: 1, warn: 2, error: 3 })

function envMinRank () {
  const k = String(process.env.LOG_LEVEL || 'debug').toLowerCase().trim()
  return LEVEL_RANK[k] != null ? LEVEL_RANK[k] : LEVEL_RANK.debug
}

function safePayload (payload) {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}

function channelForEvent (eventName) {
  if (typeof eventName !== 'string') return '[BUS]'
  if (eventName.startsWith('nav:')) return '[NAV]'
  if (eventName.startsWith('core:')) return '[CORE]'
  return '[BUS]'
}

/**
 * Structured logger: levels + optional EventBus tap (one listener per registered name; no wildcard).
 */
class Logger {
  /**
   * @param {{ prefix?: string, minLevel?: keyof typeof LEVEL_RANK, minRank?: number }} [options]
   */
  constructor (options = {}) {
    /** @readonly */
    this.prefix = options.prefix != null ? String(options.prefix) : '[BOT]'
    if (options.minRank != null && Number.isFinite(options.minRank)) {
      /** @private */
      this._minRank = Math.max(0, Math.min(3, Math.floor(options.minRank)))
    } else {
      const ml = options.minLevel != null ? String(options.minLevel).toLowerCase() : null
      /** @private */
      this._minRank = ml && LEVEL_RANK[ml] != null ? LEVEL_RANK[ml] : envMinRank()
    }
    /** @private @type {(() => void)[]} */
    this._busUnsubs = []
  }

  /** @private @param {keyof typeof LEVEL_RANK} level */
  _enabled (level) {
    return LEVEL_RANK[level] >= this._minRank
  }

  /** @private */
  _write (level, message, detail) {
    const ts = new Date().toISOString()
    const tag = level.toUpperCase().padEnd(5)
    const tail = detail !== undefined && detail !== '' ? ` ${detail}` : ''
    const line = `${ts} ${tag} ${this.prefix} ${message}${tail}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  /**
   * @param {string} message
   * @param {unknown} [detail]
   */
  debug (message, detail) {
    if (!this._enabled('debug')) return
    this._write('debug', message, detail === undefined ? undefined : safePayload(detail))
  }

  /**
   * @param {string} message
   * @param {unknown} [detail]
   */
  info (message, detail) {
    if (!this._enabled('info')) return
    this._write('info', message, detail === undefined ? undefined : safePayload(detail))
  }

  /**
   * @param {string} message
   * @param {unknown} [detail]
   */
  warn (message, detail) {
    if (!this._enabled('warn')) return
    this._write('warn', message, detail === undefined ? undefined : safePayload(detail))
  }

  /**
   * @param {string} message
   * @param {unknown} [detail]
   */
  error (message, detail) {
    if (!this._enabled('error')) return
    this._write('error', message, detail === undefined ? undefined : safePayload(detail))
  }

  /**
   * @param {string} childPrefix e.g. ` [SCHED]`
   * @returns {Logger}
   */
  child (childPrefix) {
    return new Logger({
      prefix: `${this.prefix}${String(childPrefix)}`,
      minRank: this._minRank
    })
  }

  /**
   * Subscribe to every name in `REGISTERED_EVENT_NAMES` and print one line per emit.
   *
   * @param {import('../core/EventBus').EventBus} eventBus
   * @param {{ useInfoFor?: Set<string> }} [options]
   * @returns {() => void} detach
   */
  attachEventBus (eventBus, options = {}) {
    this.detachEventBus()
    /** Pathfinder emits `partial` very often; logging each line stalls the process at LOG_LEVEL=debug. */
    const partialThrottleMs = Math.max(0, Number(process.env.LOG_NAV_PATH_PARTIAL_THROTTLE_MS ?? 400))
    let lastPartialNavLogAt = 0
    let partialSuppressedSinceLog = 0

    const useInfoFor =
      options.useInfoFor ||
      new Set([
        CoreEvents.STATE_CHANGED,
        CoreEvents.BRAIN_READY,
        CoreEvents.BRAIN_SHUTDOWN,
        NavEvents.GOTO,
        NavEvents.STOP,
        NavEvents.ARRIVED,
        NavEvents.GOAL_SET,
        NavEvents.PATH_RESULT,
        NavEvents.RECOVERY,
        NavEvents.STUCK
      ])

    for (const ev of REGISTERED_EVENT_NAMES) {
      const handler = (payload) => {
        const ch = channelForEvent(ev)
        const msg = `${ch} ${ev}`
        const detail = safePayload(payload)
        if (
          ev === NavEvents.PATH_RESULT &&
          payload &&
          typeof payload === 'object' &&
          payload.status === 'partial'
        ) {
          const now = Date.now()
          if (partialThrottleMs > 0 && now - lastPartialNavLogAt < partialThrottleMs) {
            partialSuppressedSinceLog++
            return
          }
          lastPartialNavLogAt = now
          const tail =
            partialSuppressedSinceLog > 0
              ? ` (+${partialSuppressedSinceLog} partial suppressed, LOG_NAV_PATH_PARTIAL_THROTTLE_MS=${partialThrottleMs})`
              : ''
          partialSuppressedSinceLog = 0
          this.debug(msg, detail + tail)
          return
        }
        if (useInfoFor.has(ev)) this.info(msg, detail)
        else this.debug(msg, detail)
      }
      eventBus.on(ev, handler)
      this._busUnsubs.push(() => {
        try {
          eventBus.off(ev, handler)
        } catch (_) {}
      })
    }

    return () => this.detachEventBus()
  }

  detachEventBus () {
    while (this._busUnsubs.length) {
      const u = this._busUnsubs.pop()
      try {
        u()
      } catch (_) {}
    }
  }
}

/** Default logger for core modules before DI wiring. */
const coreLogger = new Logger({ prefix: '[CORE]' })

/**
 * @param {{ prefix?: string, minLevel?: keyof typeof LEVEL_RANK, minRank?: number }} [opts]
 * @returns {Logger}
 */
function createLogger (opts) {
  return new Logger(opts)
}

module.exports = {
  Logger,
  createLogger,
  coreLogger,
  LEVEL_RANK
}
