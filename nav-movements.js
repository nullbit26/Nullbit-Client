/**
 * Расширение mineflayer-pathfinder Movements.
 *
 * CARDINAL_ONLY (рекомендации PrismarineJS по issue #310 и подобным): без диагональных шагов в графе соседей A*
 * путь чаще идёт «в обход» по прямым, а не через спорные диагональные проходы у препятствий.
 */
const BaseMovements = require('mineflayer-pathfinder/lib/movements')

const cardinalDirections = [
  { x: -1, z: 0 },
  { x: 1, z: 0 },
  { x: 0, z: -1 },
  { x: 0, z: 1 }
]

const diagonalDirections = [
  { x: -1, z: -1 },
  { x: -1, z: 1 },
  { x: 1, z: -1 },
  { x: 1, z: 1 }
]

class NavMovements extends BaseMovements {
  constructor(bot, opts = {}) {
    super(bot)
    this.navCardinalOnly = !!opts.cardinalOnly
  }

  getNeighbors(node) {
    const neighbors = []

    for (let i = 0; i < cardinalDirections.length; i++) {
      const dir = cardinalDirections[i]
      this.getMoveForward(node, dir, neighbors)
      this.getMoveJumpUp(node, dir, neighbors)
      this.getMoveDropDown(node, dir, neighbors)
      if (this.allowParkour) {
        this.getMoveParkourForward(node, dir, neighbors)
      }
    }

    if (!this.navCardinalOnly) {
      for (let i = 0; i < diagonalDirections.length; i++) {
        const dir = diagonalDirections[i]
        this.getMoveDiagonal(node, dir, neighbors)
      }
    }

    this.getMoveDown(node, neighbors)
    this.getMoveUp(node, neighbors)
    return neighbors
  }
}

module.exports = NavMovements
