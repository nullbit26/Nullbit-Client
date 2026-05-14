'use strict'

/**
 * Central command/combat policy matrix (Phase C).
 * - interruptsCombat: try to stop active combat before executing command
 * - waitForCombatEnd: wait for session lifecycle inactive before executing
 * - rejectDuringActiveCombat: reject immediately if combat session active
 */
const COMMAND_POLICY_MATRIX = /** @type {const} */ ({
  follow: { interruptsCombat: true, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  stop: { interruptsCombat: true, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  guard: { interruptsCombat: true, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  inv: { interruptsCombat: false, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  dump: { interruptsCombat: true, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  drop_item_qty: { interruptsCombat: false, waitForCombatEnd: false, rejectDuringActiveCombat: false },

  // Existing behavior for already-routed commands:
  come: { interruptsCombat: true, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  party_manage: { interruptsCombat: false, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  defend_entity: { interruptsCombat: false, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  defend_point: { interruptsCombat: false, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  cancel_defend: { interruptsCombat: false, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  craft_gear: { interruptsCombat: false, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  path_status: { interruptsCombat: false, waitForCombatEnd: false, rejectDuringActiveCombat: false },
  heal_self: { interruptsCombat: false, waitForCombatEnd: false, rejectDuringActiveCombat: false }
})

/** @param {string} command @param {boolean} fallbackInterruptsCombat */
function getCommandCombatPolicy (command, fallbackInterruptsCombat) {
  const policy = COMMAND_POLICY_MATRIX[command]
  if (policy) return policy
  return {
    interruptsCombat: !!fallbackInterruptsCombat,
    waitForCombatEnd: false,
    rejectDuringActiveCombat: false
  }
}

module.exports = {
  COMMAND_POLICY_MATRIX,
  getCommandCombatPolicy
}
