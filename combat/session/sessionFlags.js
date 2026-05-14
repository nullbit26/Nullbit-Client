'use strict'
const { EventEmitter } = require('events')

/**
 * Combat pathfinder / session exclusivity (Phase 2).
 * - `_busy`: reserved from `attackEntity` entry until `CombatSession` registers (blocks concurrent starts).
 * - `_session`: active session reference; `running` gates async helpers (ranged/melee).
 */
let _session = null
let _busy = false
const _events = new EventEmitter()
let _lastActive = false

function emitActiveChangedIfNeeded () {
  const active = getCombatSessionActive()
  if (active === _lastActive) return
  _lastActive = active
  _events.emit('active_changed', { active, at: Date.now() })
}

/**
 * @param {import('./CombatSession')|null} s
 */
function registerCombatSession (s) {
  _session = s
  _busy = false
  emitActiveChangedIfNeeded()
}

/**
 * @param {import('./CombatSession')|null} s
 */
function unregisterCombatSession (s) {
  if (_session === s) _session = null
  emitActiveChangedIfNeeded()
}

function getCombatSessionActive () {
  if (_busy) return true
  if (_session && typeof _session.isRunning === 'function') return _session.isRunning()
  return false
}

/** @returns {boolean} true if slot taken */
function tryEnterCombatExclusive () {
  if (_busy) return false
  if (_session && typeof _session.isRunning === 'function' && _session.isRunning()) return false
  _busy = true
  emitActiveChangedIfNeeded()
  return true
}

function releaseCombatExclusive () {
  _busy = false
  emitActiveChangedIfNeeded()
}

/**
 * Subscribe to active/inactive lifecycle transitions.
 * @param {(evt: { active: boolean, at: number }) => void} fn
 * @returns {() => void}
 */
function onCombatSessionActiveChanged (fn) {
  _events.on('active_changed', fn)
  return () => _events.off('active_changed', fn)
}

/** @deprecated Prefer tryEnterCombatExclusive / registerCombatSession */
function setCombatSessionActive (_v) {
  // no-op: kept only if older code called it; attackEntity Phase 2 uses try/release/register
}

module.exports = {
  registerCombatSession,
  unregisterCombatSession,
  getCombatSessionActive,
  onCombatSessionActiveChanged,
  tryEnterCombatExclusive,
  releaseCombatExclusive,
  setCombatSessionActive
}
