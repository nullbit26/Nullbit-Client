'use strict'

/**
 * @param {import('mineflayer').Bot} bot
 * @param {import('../../memory/OperationalMemory').OperationalMemory} memory
 * @param {any} config
 * @param {number} [now]
 */
function evaluateThreatPressure (bot, memory, config, now) {
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const threats = memory?.getCurrentThreats?.() || []
  const threatMemory = memory?.getActiveThreatMemory?.(t) || []

  let nearestDistance = null
  let nearbyThreatCount = 0
  const nearbyRadius = Math.max(4, Number(config?.combatFleeNearbyThreatRadiusBlocks) || 14)

  for (const row of threats) {
    const d = Number(row?.distance)
    if (!Number.isFinite(d)) continue
    if (nearestDistance == null || d < nearestDistance) nearestDistance = d
    if (d <= nearbyRadius) nearbyThreatCount++
  }

  const immediateDangerScore = scoreImmediateDanger(nearestDistance, nearbyThreatCount, config)
  const recentAggroScore = scoreRecentAggro(threatMemory, t, config)
  const combinedPressure = immediateDangerScore + recentAggroScore

  const healDistance = Math.max(6, Number(config?.combatFleeHealSafeBlocks) || 16)
  const recoverDistance = Math.max(healDistance, Number(config?.combatFleeRecoverThreatBlocks) || 18)
  const clearDistance = Math.max(8, Number(config?.combatFleeClearThreatBlocks) || 14)
  const healAggroMax = Number(config?.combatFleeHealAggroMaxScore) || 0.5
  const recoverAggroMax = Number(config?.combatFleeRecoverAggroMaxScore) || 0.35
  const exitAggroMax = Number(config?.combatFleeExitAggroMaxScore) || 0.22

  const distanceSafeForHeal = nearestDistance == null || nearestDistance >= healDistance
  const distanceSafeForRecover = nearestDistance == null || nearestDistance >= recoverDistance
  const distanceSafeForExit = nearestDistance == null || nearestDistance >= clearDistance

  const healWindowSafe = distanceSafeForHeal && recentAggroScore <= healAggroMax
  const safeToRecover = distanceSafeForRecover && recentAggroScore <= recoverAggroMax
  const safeToExitFlee = distanceSafeForExit && recentAggroScore <= exitAggroMax
  const immediateDanger = immediateDangerScore >= 1
  const recentAggroPressure = recentAggroScore >= (Number(config?.combatFleeRecentAggroHighScore) || 0.55)
  const retreatScore = evaluateRetreatScore(bot, config, {
    nearestDistance,
    nearbyThreatCount,
    immediateDangerScore,
    recentAggroScore,
    combinedPressure
  })
  const retreatScoreThreshold = Number(config?.combatFleeRetreatScoreThreshold) || 1.95

  return {
    nearestDistance,
    nearbyThreatCount,
    immediateDangerScore,
    recentAggroScore,
    combinedPressure,
    immediateDanger,
    recentAggroPressure,
    retreatScore,
    retreatScoreThreshold,
    shouldEnterFleeByRisk: retreatScore >= retreatScoreThreshold,
    healWindowSafe,
    safeToRecover,
    safeToExitFlee
  }
}

function evaluateRetreatScore (bot, config, pressureLike) {
  const hp = Number(bot?.health)
  const max = Number(bot?.maxHealth) > 0 ? Number(bot.maxHealth) : 20
  const hpRatio = Number.isFinite(hp) && max > 0 ? hp / max : 1
  const hpDeficit = Math.max(0, 1 - hpRatio)

  const hpWeight = Number(config?.combatFleeRetreatHpWeight) || 1.0
  const pressureWeight = Number(config?.combatFleeRetreatPressureWeight) || 0.58
  const nearbyWeight = Number(config?.combatFleeRetreatNearbyWeight) || 0.14
  const immediateBonus = Number(config?.combatFleeRetreatImmediateDangerBonus) || 0.2
  const nearbyCount = Number(pressureLike?.nearbyThreatCount) || 0

  const base = hpDeficit * hpWeight
  const pressurePart = (Number(pressureLike?.combinedPressure) || 0) * pressureWeight
  const nearbyPart = Math.max(0, nearbyCount - 1) * nearbyWeight
  const immediatePart = (Number(pressureLike?.immediateDangerScore) || 0) >= 1 ? immediateBonus : 0
  return base + pressurePart + nearbyPart + immediatePart
}

function scoreImmediateDanger (nearestDistance, nearbyThreatCount, config) {
  let score = 0
  const breakDist = Math.max(4, Number(config?.combatFleeBreakContactBlocks) || 9)
  const dangerDist = Math.max(breakDist + 1, Number(config?.combatFleeImmediateDangerBlocks) || 11)
  if (nearestDistance != null) {
    if (nearestDistance <= breakDist) score += 1.4
    else if (nearestDistance <= dangerDist) score += 0.8
    else if (nearestDistance <= dangerDist + 4) score += 0.35
  }
  if (nearbyThreatCount >= 4) score += 1.1
  else if (nearbyThreatCount === 3) score += 0.8
  else if (nearbyThreatCount === 2) score += 0.5
  else if (nearbyThreatCount === 1) score += 0.2
  return score
}

function scoreRecentAggro (memoryRows, now, config) {
  const freshMs = Math.max(1500, Number(config?.combatFleeAggroFreshMs) || 6000)
  const horizonMs = Math.max(freshMs + 1000, Number(config?.combatFleeAggroHorizonMs) || 12000)
  const perEntryWeight = Math.max(0.1, Number(config?.combatFleeAggroEntryWeight) || 0.22)
  let score = 0
  for (const row of memoryRows) {
    const seen = Number(row?.lastSeenAt)
    if (!Number.isFinite(seen)) continue
    const age = now - seen
    if (age < 0 || age > horizonMs) continue
    const freshness = Math.max(0, 1 - age / horizonMs)
    const isFresh = age <= freshMs
    const freshnessBoost = isFresh ? 1.8 : 1
    score += freshness * perEntryWeight * freshnessBoost
    if (isFresh) score += 0.15
  }
  return Math.min(2.5, score)
}

module.exports = { evaluateThreatPressure, evaluateRetreatScore }
