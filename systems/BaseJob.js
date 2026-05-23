'use strict'

/**
 * BaseJob — minimal contract for all resource-gathering FSM jobs.
 *
 * Execution contract (same for any job type):
 *   lock target → scan remaining work → pick valid action spot →
 *   navigate → (clear blockers if needed) → interact → collect →
 *   repeat until complete or bounded-fail
 *
 * Subclasses must implement:
 *   - async run()        → 'complete' | 'fail' | 'interrupted'
 *   - destroy()          — detach bus listeners, release resources
 *   - get metrics()      → { jobType, durationMs, blocksDigged, navProbes,
 *                            totalPartials, blockerClears, failedBlocks, failReason }
 *
 * @abstract
 */
class BaseJob {
  /**
   * Run the FSM to completion.
   * @returns {Promise<'complete'|'fail'|'interrupted'>}
   */
  async run () {
    throw new Error(`[${this.constructor.name}] run() not implemented`)
  }

  /**
   * Signal the job to stop cooperatively.
   * Subclasses should make run() return 'interrupted' on next check.
   */
  interrupt () {}

  /**
   * Release bus listeners and any held state.
   * Safe to call multiple times.
   */
  destroy () {}

  /**
   * Unified telemetry snapshot.
   * @returns {{
   *   jobType: string,
   *   durationMs: number,
   *   blocksDigged: number,
   *   navProbes: number,
   *   totalPartials: number,
   *   blockerClears: number,
   *   failedBlocks: number,
   *   failReason: string | null
   * }}
   */
  get metrics () {
    return {
      jobType: 'unknown',
      durationMs: 0,
      blocksDigged: 0,
      navProbes: 0,
      totalPartials: 0,
      blockerClears: 0,
      failedBlocks: 0,
      failReason: null
    }
  }
}

module.exports = { BaseJob }
