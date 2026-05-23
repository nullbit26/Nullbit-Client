'use strict'

const mineflayer = require('mineflayer')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

const HOST      = process.env.MC_HOST    || 'localhost'
const PORT      = Number(process.env.MC_PORT || 25565)
const VERSION   = process.env.MC_VERSION || '1.21.1'
const OP_NAME   = process.env.MC_USERNAME || 'HomeBot'  // must be op: /op HomeBot
const ARMY_PREFIX = 'Beer'
const ARMY_SIZE   = 20

const gearConfig = require('./gear_config')

// Parse 'item:count' or just 'item'
function parseItem (entry) {
  const parts = entry.split(':')
  return { name: parts[0].trim(), count: parts[1] ? parseInt(parts[1]) : 1 }
}

// Build list of /give commands for one bot
function buildCommands (botName) {
  const items = gearConfig[botName] || gearConfig['default'] || []
  return items.map(function (entry) {
    const it = parseItem(entry)
    return '/give ' + botName + ' ' + it.name + ' ' + it.count
  })
}

console.log('[GiveGear] Connecting as ' + OP_NAME + ' to ' + HOST + ':' + PORT)

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: OP_NAME,
  version: VERSION,
  auth: 'offline'
})

bot.once('spawn', function () {
  console.log('[GiveGear] Connected. Sending gear commands...')

  var commands = []
  for (var i = 1; i <= ARMY_SIZE; i++) {
    var name = ARMY_PREFIX + '_' + i
    var cmds = buildCommands(name)
    cmds.forEach(function (cmd) { commands.push(cmd) })
  }

  console.log('[GiveGear] Total commands: ' + commands.length)

  // Keepalive - look around so server doesn't kick for inactivity
  var keepAlive = setInterval(function () {
    try { bot.look(bot.entity.yaw + 0.1, 0, false) } catch (_) {}
  }, 5000)

  // Send commands one by one with 400ms gap
  var idx = 0
  var interval = setInterval(function () {
    if (idx >= commands.length) {
      clearInterval(interval)
      clearInterval(keepAlive)
      console.log('[GiveGear] Done! Sending !squad gear...')
      bot.chat('!squad gear')
      setTimeout(function () { bot.quit() }, 3000)
      return
    }
    console.log('[GiveGear] (' + (idx+1) + '/' + commands.length + ') ' + commands[idx])
    try { bot.chat(commands[idx]) } catch (e) { console.error('[GiveGear] send error: ' + e.message) }
    idx++
  }, 700)
})

bot.on('error', function (err) {
  console.error('[GiveGear] Error: ' + err.message)
})

bot.on('kicked', function (reason) {
  console.error('[GiveGear] Kicked: ' + reason)
  console.error('[GiveGear] Make sure ' + OP_NAME + ' is OP on the server!')
})
