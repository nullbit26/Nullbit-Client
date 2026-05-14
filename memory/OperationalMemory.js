'use strict'

/** Max remembered aggressor rows (deduped by entityId). */
const MAX_THREAT_ENTRIES = 16

/** Default TTL when `expiresAt` omitted (ms). */
const DEFAULT_THREAT_TTL_MS = 120_000

/**
 * @typedef {Object} ThreatMemoryEntry
 * @property {number} entityId
 * @property {string} reason
 * @property {string} protectedTargetType — e.g. `bot`, `party_player`, `friend_mob`
 * @property {string} protectedTargetIdOrName — username, mob id string, or label
 * @property {number} lastSeenAt
 * @property {number} expiresAt
 */

/**
 * Central in-process snapshot of what the awareness layer last observed.
 * Other systems read this instead of re-scanning entities.
 *
 * **Data shape**
 * - `nearbyPlayers` — last `scanEnvironment` player rows (username, dist, trashHand, …) from `getEnvironment.scanEnvironment`.
 * - `currentThreats` — entities whose effective IFF is HOSTILE within the danger radius (PartyIFFSystem + threat memory); `Map<string, { id, name, distance }>` keyed by `String(id)`.
 * - `threatMemory` — lightweight TTL aggressor list (see {@link ThreatMemoryEntry}); used by PartyIFF for temporary hostility.
 * - `lastAttacker` — **not** structural threat memory: last **nearby player who took damage** (social / taunt / flee username hint): `{ username, distance, at }`. Does not record damage source or mob attackers.
 * - `hazards` — reserved list for future nav / hazard summaries; optional `{ kind, detail }` entries.
 * - `followTarget` — last follow/guard target snapshot from {@link ../systems/FollowSystem} (`username`, `x,y,z`, `mode`).
 */
class OperationalMemory {
  constructor () {
    /** @private @type {Object[]} */
    this._nearbyPlayers = []
    /** @private @type {Map<string, { id: number, name: string, distance: number }>} */
    this._currentThreats = new Map()
    /** @private @type {ThreatMemoryEntry[]} */
    this._threatMemory = []
    /** @private @type {{ username: string, distance: number, at: number } | null} */
    this._lastAttacker = null
    /** @private @type {Object[]} */
    this._hazards = []
    /** @private @type {Object | null} */
    this._lastScanSnapshot = null
    /** @private @type {{ username: string, x: number, y: number, z: number, mode: string, at: number } | null} */
    this._followTarget = null
  }

  /** @returns {Object[]} */
  getNearbyPlayers () {
    return this._nearbyPlayers
  }

  /** @param {Object[]} players */
  setNearbyPlayers (players) {
    this._nearbyPlayers = Array.isArray(players) ? players.map((p) => ({ ...p })) : []
  }

  /** @returns {{ id: number, name: string, distance: number }[]} */
  getCurrentThreats () {
    return Array.from(this._currentThreats.values(), (t) => ({ ...t }))
  }

  /** @param {{ id: number, name: string, distance: number }[]} threats */
  setCurrentThreats (threats) {
    const next = new Map()
    if (Array.isArray(threats)) {
      for (const t of threats) {
        const id = Number(t?.id)
        if (!Number.isFinite(id)) continue
        const key = String(id)
        next.set(key, {
          id,
          name: String(t?.name || ''),
          distance: Number(t?.distance)
        })
      }
    }
    this._currentThreats = next
  }

  /**
   * @param {number} [now]
   */
  purgeExpiredThreats (now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now()
    this._threatMemory = this._threatMemory.filter((e) => e.expiresAt > t)
  }

  /**
   * @param {Partial<ThreatMemoryEntry> & { entityId: number }} entry
   */
  recordThreat (entry) {
    const now = Date.now()
    const entityId = Number(entry.entityId)
    if (!Number.isFinite(entityId)) return

    const lastSeenAt = Number.isFinite(Number(entry.lastSeenAt)) ? Number(entry.lastSeenAt) : now
    const expiresAt = Number.isFinite(Number(entry.expiresAt))
      ? Number(entry.expiresAt)
      : lastSeenAt + DEFAULT_THREAT_TTL_MS

    this.purgeExpiredThreats(now)

    const row = {
      entityId,
      reason: String(entry.reason != null ? entry.reason : 'unknown').slice(0, 96),
      protectedTargetType: String(entry.protectedTargetType != null ? entry.protectedTargetType : 'unknown').slice(0, 48),
      protectedTargetIdOrName: String(
        entry.protectedTargetIdOrName != null ? entry.protectedTargetIdOrName : ''
      ).slice(0, 96),
      lastSeenAt,
      expiresAt
    }

    const idx = this._threatMemory.findIndex((e) => e.entityId === entityId)
    if (idx >= 0) {
      this._threatMemory[idx] = row
    } else {
      this._threatMemory.push(row)
      while (this._threatMemory.length > MAX_THREAT_ENTRIES) {
        this._threatMemory.sort((a, b) => a.lastSeenAt - b.lastSeenAt)
        this._threatMemory.shift()
      }
    }
  }

  /**
   * @param {number} [now]
   * @returns {ThreatMemoryEntry[]}
   */
  getActiveThreats (now) {
    return this.getCurrentThreats()
  }

  /**
   * Aggro memory rows with TTL (legacy/helper API for PartyIFF fallback paths).
   * @param {number} [now]
   * @returns {ThreatMemoryEntry[]}
   */
  getActiveThreatMemory (now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now()
    this.purgeExpiredThreats(t)
    return this._threatMemory.map((e) => ({ ...e }))
  }

  /**
   * @param {number} entityId
   * @param {number} [now]
   */
  isThreatEntityActive (entityId, now) {
    const key = String(entityId)
    if (this._currentThreats.has(key)) return true
    const id = Number(entityId)
    if (!Number.isFinite(id)) return false
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now()
    this.purgeExpiredThreats(t)
    return this._threatMemory.some((e) => e.entityId === id && e.expiresAt > t)
  }

  /** @returns {{ username: string, distance: number, at: number } | null} */
  getLastAttacker () {
    return this._lastAttacker ? { ...this._lastAttacker } : null
  }

  /**
   * Last **nearby player hurt** (voice / taunt / flee hint). Not who hit the bot; use `threatMemory` for aggressors.
   * @param {{ username: string, distance: number, at: number } | null} row
   */
  setLastAttacker (row) {
    if (!row || typeof row.username !== 'string') {
      this._lastAttacker = null
      return
    }
    this._lastAttacker = {
      username: row.username,
      distance: Number(row.distance),
      at: Number(row.at)
    }
  }

  /** @returns {Object[]} */
  getHazards () {
    return this._hazards.map((h) => ({ ...h }))
  }

  /** @param {Object[]} hazards */
  setHazards (hazards) {
    this._hazards = Array.isArray(hazards) ? hazards.map((h) => ({ ...h })) : []
  }

  /** @returns {Object | null} */
  getLastScanSnapshot () {
    return this._lastScanSnapshot ? { ...this._lastScanSnapshot } : null
  }

  /**
   * Stores a shallow clone of `snap` and derives `nearbyPlayers` when `snap.players` exists.
   * @param {Object | null} snap
   */
  applyScanSnapshot (snap) {
    if (!snap || typeof snap !== 'object' || !snap.ok) {
      return
    }
    this._lastScanSnapshot = { ...snap }
    if (Array.isArray(snap.players)) {
      this._nearbyPlayers = snap.players.map((p) => ({ ...p }))
    }
  }

  /**
   * @param {{ username: string, x: number, y: number, z: number, mode: string, at: number } | null} snap
   */
  setFollowTarget (snap) {
    if (!snap || typeof snap.username !== 'string') {
      this._followTarget = null
      return
    }
    this._followTarget = {
      username: snap.username,
      x: Number(snap.x),
      y: Number(snap.y),
      z: Number(snap.z),
      mode: String(snap.mode || ''),
      at: Number(snap.at)
    }
  }

  /** @returns {{ username: string, x: number, y: number, z: number, mode: string, at: number } | null} */
  getFollowTarget () {
    return this._followTarget ? { ...this._followTarget } : null
  }

  clear () {
    this._nearbyPlayers = []
    this._currentThreats = new Map()
    this._threatMemory = []
    this._lastAttacker = null
    this._hazards = []
    this._lastScanSnapshot = null
    this._followTarget = null
  }
}

module.exports = { OperationalMemory }
