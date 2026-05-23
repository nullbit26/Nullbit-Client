'use strict'

const fs = require('fs')
const path = require('path')

/** Default file path — same dir as homebase.json */
const DEFAULT_PATH = path.resolve('./config/caves.json')

/**
 * Persists the `_visitedCaves` Map (key → visitedAt timestamp) to a JSON file.
 *
 * File format:
 * ```json
 * { "entries": [["x,y,z", 1716288000000], ...], "savedAt": 1716288005000 }
 * ```
 *
 * TTL eviction is applied on every load — expired entries are not restored.
 */

/**
 * Load visited caves from disk into an existing Map.
 * Expired entries (older than ttlMs) are silently dropped.
 *
 * @param {Map<string, number>} map   — target map to populate
 * @param {number} ttlMs             — TTL in ms (same as CAVE_VISITED_TTL_MS)
 * @param {string} [filePath]
 * @returns {number} count of entries loaded
 */
function loadVisitedCaves (map, ttlMs, filePath) {
  const fpath = filePath || DEFAULT_PATH
  try {
    if (!fs.existsSync(fpath)) return 0
    const raw = fs.readFileSync(fpath, 'utf8')
    const data = JSON.parse(raw)
    if (!Array.isArray(data?.entries)) return 0
    const now = Date.now()
    let loaded = 0
    for (const [key, ts] of data.entries) {
      if (typeof key !== 'string') continue
      const t = Number(ts)
      if (!Number.isFinite(t)) continue
      if (now - t >= ttlMs) continue // expired — skip
      map.set(key, t)
      loaded++
    }
    return loaded
  } catch (_) {
    return 0
  }
}

/**
 * Save the entire visited caves Map to disk, evicting expired entries first.
 *
 * @param {Map<string, number>} map
 * @param {number} ttlMs
 * @param {string} [filePath]
 * @returns {boolean} true if write succeeded
 */
function saveVisitedCaves (map, ttlMs, filePath) {
  const fpath = filePath || DEFAULT_PATH
  try {
    const now = Date.now()
    const entries = []
    for (const [key, ts] of map) {
      if (now - ts < ttlMs) entries.push([key, ts])
    }
    const dir = path.dirname(fpath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(fpath, JSON.stringify({ entries, savedAt: now }, null, 2), 'utf8')
    return true
  } catch (_) {
    return false
  }
}

/**
 * Add a single cave entry to the map and immediately persist to disk.
 * This is the hot-path called by CaveExplorerJob after every visit.
 *
 * @param {Map<string, number>} map
 * @param {string} key       — "x,y,z"
 * @param {number} ts        — Date.now()
 * @param {number} ttlMs
 * @param {string} [filePath]
 */
function addAndPersist (map, key, ts, ttlMs, filePath) {
  map.set(key, ts)
  saveVisitedCaves(map, ttlMs, filePath)
}

module.exports = { loadVisitedCaves, saveVisitedCaves, addAndPersist, DEFAULT_PATH }
