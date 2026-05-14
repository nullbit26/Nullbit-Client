'use strict'

const getEnvironment = require('./getEnvironment')

/** Верхняя граница длины всего брифинга (символы) — меньше токенов в каждом сообщении в тред. */
const DEFAULT_MAX_CHARS = 520
const INV_TOP = 12
const INV_MAX_CHARS = 130

/**
 * Короткая сводка для OpenAI Assistant / NVIDIA: режим, ресурсы, угрозы, кто рядом.
 * Один вызов scanEnvironment (без пяти findBlocks из getEnvironment) — дешевле по CPU.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ mode?: string, targetUsername?: string | null }} state
 * @param {{ radius?: number, maxChars?: number }} [opts]
 * @returns {string}
 */
function formatAssistantBriefing (bot, state, opts = {}) {
  const maxChars = Math.min(Math.max(Number(opts.maxChars) || DEFAULT_MAX_CHARS, 200), 1200)
  const radius = Math.min(Math.max(Number(opts.radius) || 20, 8), 28)

  const health = bot.health != null ? String(Math.round(bot.health * 10) / 10) : '?'
  const food = bot.food != null ? String(bot.food) : '?'
  const pos = bot.entity?.position
  const posStr = pos ? `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}` : '?'
  const mode = state?.mode != null ? String(state.mode) : '?'
  const tgt = state?.targetUsername ? String(state.targetUsername) : 'нет'

  function compactInv () {
    const items = bot.inventory.items()
    if (!items.length) return 'пусто'
    let s = [...items]
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, INV_TOP)
      .map((i) => `${i.name}×${i.count}`)
      .join(', ')
    if (s.length > INV_MAX_CHARS) s = `${s.slice(0, INV_MAX_CHARS - 1)}…`
    return s
  }

  function armorLine () {
    const idx = { head: 5, torso: 6, legs: 7, feet: 8 }
    const L = { head: 'Г', torso: 'Т', legs: 'Н', feet: 'Б' }
    const parts = []
    for (const k of ['head', 'torso', 'legs', 'feet']) {
      const it = bot.inventory.slots[idx[k]]
      if (it?.name) parts.push(`${L[k]}:${it.name}`)
    }
    return parts.length ? parts.join(' ') : 'брони нет'
  }

  const lines = []
  lines.push(
    `Режим:${mode} цель:${tgt} HP:${health}/20 голод:${food}/20 xyz:${posStr} | ${armorLine()}`
  )
  lines.push(`Инв(топ): ${compactInv()}`)

  const snap = getEnvironment.scanEnvironment(bot, radius)
  if (!snap.ok) {
    return clampJoin(lines, maxChars)
  }

  if (snap.hostileMinDist != null && snap.hostileNearestName) {
    const nm = String(snap.hostileNearestName).replace(/_/g, ' ')
    const c =
      snap.creeperMinDist != null
        ? ` крипер~${Math.round(snap.creeperMinDist)}м`
        : ''
    lines.push(`Угроза: ${nm} ~${Math.round(snap.hostileMinDist)}м${c}`)
  } else {
    lines.push('Враждебных в радиусе не видно.')
  }

  if (snap.players?.length) {
    const bits = snap.players.slice(0, 2).map((p) => `${p.username}~${p.distRounded}м`)
    const more = snap.players.length > 2 ? ` +${snap.players.length - 2}` : ''
    lines.push(`Игроки: ${bits.join('; ')}${more}`)
  }

  if (snap.premiumOreVisible && snap.premiumOreName) {
    lines.push(`Руда на виду: ${snap.premiumOreName} ~${snap.premiumOreDist}м`)
  }

  return clampJoin(lines, maxChars)
}

function clampJoin (lines, maxChars) {
  let out = lines.join('\n')
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`
  return out
}

module.exports = { formatAssistantBriefing }
