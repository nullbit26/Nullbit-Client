/**
 * Убирает DeprecationWarning: physicTick → physicsTick (mineflayer 4.x).
 */
'use strict'

const fs = require('fs')
const path = require('path')

const PVP = path.join(__dirname, '..', 'node_modules', 'mineflayer-pvp', 'lib', 'PVP.js')

function run() {
  if (!fs.existsSync(PVP)) {
    console.log('[pvp-patch] skip: mineflayer-pvp not installed')
    return
  }

  let s = fs.readFileSync(PVP, 'utf8')
  const before = "this.bot.on('physicTick', () => this.update());"
  if (!s.includes(before)) {
    if (s.includes("this.bot.on('physicsTick'")) console.log('[pvp-patch] OK — уже physicsTick')
    else console.warn('[pvp-patch] не найден physicTick-слушатель — пропуск')
    return
  }

  s = s.replace(before, "this.bot.on('physicsTick', () => this.update());")
  fs.writeFileSync(PVP, s, 'utf8')
  console.log('[pvp-patch] physicTick заменён на physicsTick')
}

run()
