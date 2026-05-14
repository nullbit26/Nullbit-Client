module.exports = function createUtils(bot) {
  function log(...args) {
    console.log(new Date().toISOString(), '-', ...args)
  }

  function getPlayerEntity(username) {
    if (!bot || !username) return null
    return bot.players[username]?.entity || null
  }

  function getFrontBlock() {
    if (!bot?.entity) return null
    const yaw = bot.entity.yaw
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    const ahead = bot.entity.position.offset(fx * 0.9, 0, fz * 0.9)
    const chestBlock = bot.blockAt(ahead.offset(0, 0.5, 0))
    const feetBlock = bot.blockAt(ahead.offset(0, -0.5, 0))
    return { chestBlock, feetBlock }
  }

  function getFeetBlock() {
    if (!bot?.entity) return null
    return bot.blockAt(bot.entity.position.offset(0, -0.1, 0))
  }

  return {
    getPlayerEntity,
    getFrontBlock,
    getFeetBlock,
    log
  }
}
