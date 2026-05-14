'use strict'

const { Vec3 } = require('vec3')

/**
 * Hazard / lava evaluation and pathfinder augmentation (moved from `features/navSafety` math).
 * Steer / global tick policy stays in `navSafety.js` and calls into this class.
 */
const HAZARD_CFG = Object.freeze({
  CAUTIOUS_EDGE_AIR_MIN: 5,
  LAVA_NEIGHBOR_RADIUS: 3,
  LAVA_ESCAPE_SCAN_RADIUS: 4,
  HAZARD_DETOUR_SCAN_RADIUS: 5
})

const LAVAISH_NAMES = [
  'lava',
  'flowing_lava',
  'fire',
  'soul_fire',
  'magma_block',
  'campfire',
  'soul_campfire'
]

const HAZARD_REGISTRY_NAMES = [
  'lava',
  'flowing_lava',
  'fire',
  'soul_fire',
  'magma_block',
  'campfire',
  'soul_campfire',
  'cactus',
  'sweet_berry_bush',
  'powder_snow',
  'wither_rose'
]

class HazardEvaluator {
  /** @readonly */
  get cfg () {
    return HAZARD_CFG
  }

  isLavaBlockName (name) {
    if (!name) return false
    const n = name.toLowerCase()
    return n.includes('lava')
  }

  isHazardRepulsionBlockName (name) {
    if (!name) return false
    const n = name.toLowerCase()
    if (this.isLavaBlockName(n)) return true
    return (
      LAVAISH_NAMES.some((x) => n.includes(x)) ||
      n.includes('cactus') ||
      n.includes('sweet_berry') ||
      n.includes('wither_rose') ||
      n.includes('powder_snow')
    )
  }

  isNearLavaOrFire (bot) {
    const pos = bot.entity.position
    const R = HAZARD_CFG.LAVA_NEIGHBOR_RADIUS
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -1; dy <= 2; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz))
          if (b && LAVAISH_NAMES.some((n) => b.name && b.name.includes(n))) return true
        }
      }
    }
    return false
  }

  countAirColumnDown (bot, x, startY, z) {
    let n = 0
    for (let y = startY; y >= startY - 28; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) return 0
      if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' || b.boundingBox === 'empty') n++
      else break
    }
    return n
  }

  isStandableBlock (b) {
    if (!b || b.boundingBox !== 'block') return false
    const n = (b.name || '').toLowerCase()
    if (n.includes('lava') || n.includes('fire') || n.includes('magma')) return false
    return true
  }

  lethalDropNearFeet (bot) {
    if (!bot.entity?.position) return false
    const pos = bot.entity.position
    const yaw = bot.entity.yaw ?? 0
    const by = Math.floor(pos.y) - 1
    const thr = HAZARD_CFG.CAUTIOUS_EDGE_AIR_MIN
    const deltas = [-0.4, 0, 0.4]
    for (const da of deltas) {
      const a = yaw + da
      const fx = -Math.sin(a) * 1.25
      const fz = Math.cos(a) * 1.25
      const bx = Math.floor(pos.x + fx)
      const bz = Math.floor(pos.z + fz)
      const b = bot.blockAt(new Vec3(bx, by, bz))
      if (b == null) continue
      if (this.isStandableBlock(b)) continue
      const air = this.countAirColumnDown(bot, bx, by, bz)
      if (air >= thr) return true
    }
    return false
  }

  evaluateCautiousWalk (bot) {
    if (!bot.entity?.position) return false
    return this.lethalDropNearFeet(bot) || this.isNearLavaOrFire(bot)
  }

  augmentMovementsHazards (bot, movements) {
    if (!movements?.blocksToAvoid || !bot.registry?.blocksByName) return

    if (Array.isArray(movements.exclusionAreasStep)) {
      movements.exclusionAreasStep = movements.exclusionAreasStep.filter((f) => !f || !f._navSafetyHazardStep)
    } else {
      movements.exclusionAreasStep = []
    }

    const stepPenalty = (block) => {
      if (!block?.position) return 0
      const px = block.position.x
      const py = block.position.y
      const pz = block.position.z
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const dy of [-2, -1, 0]) {
            if (dx === 0 && dz === 0 && dy === 0) continue
            const b = bot.blockAt(new Vec3(px + dx, py + dy, pz + dz))
            if (!b?.name) continue
            const n = b.name.toLowerCase()
            if (n.includes('lava') || n.includes('magma_block')) return 12
          }
        }
      }
      return 0
    }
    stepPenalty._navSafetyHazardStep = true
    movements.exclusionAreasStep.push(stepPenalty)

    for (const name of HAZARD_REGISTRY_NAMES) {
      const block = bot.registry.blocksByName[name]
      if (block?.id) movements.blocksToAvoid.add(block.id)
    }

    const arr = bot.registry.blocksArray
    if (Array.isArray(arr)) {
      for (const reg of arr) {
        const n = (reg.name || '').toLowerCase()
        if (!n || !reg.id) continue
        if (n.includes('lava')) movements.blocksToAvoid.add(reg.id)
      }
    }
  }

  touchesLavaOrInLava (bot) {
    if (!bot.entity?.position) return false
    if (bot.entity.isInLava) return true
    const pos = bot.entity.position
    for (const [dx, dy, dz] of [
      [0, 0, 0],
      [0, -1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1]
    ]) {
      const b = bot.blockAt(pos.offset(dx, dy, dz))
      if (b && this.isLavaBlockName(b.name)) return true
    }
    return false
  }

  getHazardRepulsionWorldDirXZ (bot, radius) {
    if (!bot.entity?.position) return null
    const pos = bot.entity.position
    const px = pos.x
    const pz = pos.z
    const fx0 = Math.floor(pos.x)
    const fy = Math.floor(pos.y)
    const fz0 = Math.floor(pos.z)
    const R =
      Number.isFinite(radius) && radius > 0 ? Math.floor(radius) : HAZARD_CFG.LAVA_ESCAPE_SCAN_RADIUS
    const samples = []
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          const b = bot.blockAt(new Vec3(fx0 + dx, fy + dy, fz0 + dz))
          if (b && this.isHazardRepulsionBlockName(b.name)) {
            samples.push([b.position.x + 0.5, b.position.z + 0.5])
          }
        }
      }
    }
    if (samples.length === 0) return null
    let cx = 0
    let cz = 0
    for (const [sx, sz] of samples) {
      cx += sx
      cz += sz
    }
    cx /= samples.length
    cz /= samples.length
    let ex = px - cx
    let ez = pz - cz
    let len = Math.hypot(ex, ez)
    if (len < 0.12) {
      let found = false
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const b = bot.blockAt(new Vec3(fx0 + dx, fy, fz0 + dz))
        if (b && !this.isHazardRepulsionBlockName(b.name)) {
          ex = dx
          ez = dz
          len = Math.hypot(ex, ez)
          found = true
          break
        }
      }
      if (!found || len < 1e-6) return { x: 1, z: 0 }
    }
    ex /= len
    ez /= len
    return { x: ex, z: ez }
  }

  getPathfinderGoalDirXZ (bot) {
    try {
      const g = bot.pathfinder?.goal
      if (!g || !bot.entity?.position) return null
      const pos = bot.entity.position
      let tx
      let tz
      if (g.entity && g.entity.position) {
        tx = g.entity.position.x
        tz = g.entity.position.z
      } else if (typeof g.x === 'number' && typeof g.z === 'number') {
        tx = g.x + 0.5
        tz = g.z + 0.5
      } else return null
      const dx = tx - pos.x
      const dz = tz - pos.z
      const len = Math.hypot(dx, dz)
      if (len < 0.35) return null
      return { x: dx / len, z: dz / len }
    } catch {
      return null
    }
  }

  getCliffRetreatDirXZ (bot) {
    if (!this.lethalDropNearFeet(bot)) return null
    const yaw = bot.entity.yaw ?? 0
    return { x: Math.sin(yaw), z: -Math.cos(yaw) }
  }

  tangentialDetourTowardGoal (goal, repel) {
    if (!goal) return repel
    if (!repel) return goal
    const len = Math.hypot(repel.x, repel.z)
    if (len < 1e-4) return goal
    const ux = repel.x / len
    const uz = repel.z / len
    const t1x = -uz
    const t1z = ux
    const t2x = uz
    const t2z = -ux
    const g1 = goal.x * t1x + goal.z * t1z
    const g2 = goal.x * t2x + goal.z * t2z
    return g1 >= g2 ? { x: t1x, z: t1z } : { x: t2x, z: t2z }
  }

  clampDirNonTowardHazard (dir, repel) {
    if (!dir || !repel) return dir
    const rl = Math.hypot(repel.x, repel.z)
    if (rl < 1e-4) return dir
    const ux = repel.x / rl
    const uz = repel.z / rl
    const d = dir.x * ux + dir.z * uz
    if (d >= -0.04) return dir
    let sx = dir.x - d * ux
    let sz = dir.z - d * uz
    const sl = Math.hypot(sx, sz)
    if (sl < 0.07) return { x: -uz, z: ux }
    return { x: sx / sl, z: sz / sl }
  }

  blendDetourXZ (goal, repel) {
    if (!repel) return goal
    if (!goal) return repel
    const dot = goal.x * repel.x + goal.z * repel.z
    if (dot < 0.2) {
      return this.tangentialDetourTowardGoal(goal, repel)
    }
    let sx = repel.x - dot * goal.x
    let sz = repel.z - dot * goal.z
    const sl = Math.hypot(sx, sz)
    if (sl > 1e-3) {
      sx /= sl
      sz /= sl
      const wx = goal.x * 0.55 + sx * 0.45
      const wz = goal.z * 0.55 + sz * 0.45
      const wl = Math.hypot(wx, wz)
      if (wl > 1e-3) return this.clampDirNonTowardHazard({ x: wx / wl, z: wz / wl }, repel)
    }
    const fb = Math.abs(dot) > 0.82 ? repel : goal
    return this.clampDirNonTowardHazard(fb, repel)
  }
}

module.exports = {
  HazardEvaluator,
  HAZARD_CFG,
  HAZARD_REGISTRY_NAMES,
  LAVAISH_NAMES
}
