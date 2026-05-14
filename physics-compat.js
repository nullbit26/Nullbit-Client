/**
 * Prismarine physics/pathfinding клиентская модель часто чуть уже серверной (GitHub mineflayer-pathfinder #223).
 * Лёгкое увеличение width/height снижает «утыкание» и клип при разном latency (VPN и т.д.).
 */
module.exports = function applyPhysicsHitboxInflate(bot, delta) {
  if (!(delta > 0) || !bot?.entity) return
  bot.entity.width = Number(bot.entity.width ?? 0.6) + delta
  bot.entity.height = Number(bot.entity.height ?? 1.8) + delta
}
