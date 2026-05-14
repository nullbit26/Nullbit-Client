'use strict'

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DEFAULT_POLL_MS = 80

/**
 * Wait until `isActive()` is false or `maxMs` elapses.
 * Uses lifecycle subscription when provided, with polling fallback.
 *
 * @param {{ isActive: () => boolean, subscribeActiveChanged?: (fn: (evt: { active: boolean, at: number }) => void) => (() => void), maxMs?: number, sleepMs?: number, sleep?: (ms: number) => Promise<void> }} opts
 */
async function waitUntilCombatInactive (opts) {
  const isActive = opts.isActive
  const subscribeActiveChanged = opts.subscribeActiveChanged
  const maxMs = opts.maxMs != null ? opts.maxMs : 120000
  const sleepMs = opts.sleepMs != null ? opts.sleepMs : DEFAULT_POLL_MS
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep
  const deadline = Date.now() + maxMs
  while (isActive()) {
    if (Date.now() >= deadline) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    if (typeof subscribeActiveChanged === 'function') {
      await new Promise((resolve) => {
        const step = Math.min(sleepMs, Math.max(20, remaining))
        let done = false
        const timer = setTimeout(finish, step)
        const unsubscribe = subscribeActiveChanged((evt) => {
          if (evt && evt.active === false) finish()
        })
        function finish () {
          if (done) return
          done = true
          clearTimeout(timer)
          try { unsubscribe && unsubscribe() } catch (_) {}
          resolve()
        }
      })
    } else {
      await sleep(Math.min(sleepMs, Math.max(20, remaining)))
    }
  }
}

module.exports = { waitUntilCombatInactive, DEFAULT_POLL_MS }
