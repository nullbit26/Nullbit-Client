'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const { plugin: pvp } = require('mineflayer-pvp')
const path = require('path')

// Load same .env as main bot
require('dotenv').config({ path: path.join(__dirname, '.env') })

const HOST    = process.env.MC_HOST    || 'localhost'
const PORT    = Number(process.env.MC_PORT || 25565)
const VERSION = process.env.MC_VERSION || '1.21.1'
const MAIN_BOT_NAME = process.env.MC_USERNAME || 'HomeBot'
const COMMANDER = 'BIG_KOSHAK13'

const ARMY_SIZE   = 20
const ARMY_PREFIX = 'Beer'
const SPAWN_DELAY_MS = 1500  // delay between each bot connecting

const soldiers = []

// ─── Command handler ──────────────────────────────────────────────────────────

function handleCommand (bot, cmd, args, sender, idx) {
  switch (cmd) {
    case 'follow':
      startFollow(bot, sender, idx)
      bot.chat(bot.username + ' following!')
      break

    case 'stop':
      stopAll(bot)
      try { bot.pvp.stop() } catch (_) {}
      bot.chat(bot.username + ' stopped.')
      break

    case 'come':
      comeToPlayer(bot, sender, idx)
      break

    case 'attack': {
      const targetName = args[0]
      if (!targetName) break
      if (targetName === 'nearest' || targetName === 'mobs' || targetName === 'hostile') {
        startAttackNearest(bot)
      } else {
        const entity = Object.values(bot.entities).find(function (e) {
          return e.username === targetName || e.name === targetName
        })
        if (entity) {
          try { bot.attack(entity) } catch (_) {}
        }
      }
      break
    }

    case 'guard':
      startGuard(bot, idx)
      break

    case 'escort':
      startEscort(bot, sender, idx)
      break

    case 'say':
      bot.chat(args.join(' '))
      break

    case 'form':
      formUp(bot, args[0], sender, idx)
      break

    case 'gear':
      setTimeout(function () { equipGear(bot, args[0]) }, 500)
      break

    default:
      break
  }
}

function findPlayer (bot, name) {
  return Object.values(bot.entities).find(function (e) {
    return e.type === 'player' && e.username === name
  })
}

// Returns unique XZ offset for each bot so they don't stack
function getBotOffset (idx, totalRadius) {
  var r = totalRadius || 2
  // spread bots in a ring, each bot gets its own angle slot
  var angle = (2 * Math.PI / ARMY_SIZE) * (idx - 1)
  return {
    dx: Math.round(Math.cos(angle) * r),
    dz: Math.round(Math.sin(angle) * r)
  }
}

function startFollow (bot, targetName, idx) {
  stopAll(bot)
  bot._followTarget = targetName
  bot._armyInterval = setInterval(function () {
    const target = findPlayer(bot, bot._followTarget)
    if (!target) return
    var off = getBotOffset(idx, 3)
    var tx = Math.round(target.position.x + off.dx)
    var tz = Math.round(target.position.z + off.dz)
    bot.pathfinder.setGoal(new goals.GoalNear(tx, target.position.y, tz, 1), true)
  }, 800)
}

function comeToPlayer (bot, targetName, idx) {
  stopAll(bot)
  const target = findPlayer(bot, targetName)
  if (!target) {
    console.log('[Army] ' + bot.username + ': cant find ' + targetName)
    return
  }
  var off = getBotOffset(idx, 3)
  var tx = Math.round(target.position.x + off.dx)
  var tz = Math.round(target.position.z + off.dz)
  bot.pathfinder.setGoal(new goals.GoalNear(tx, target.position.y, tz, 1), false)
}

var HOSTILE_MOBS = [
  'zombie', 'zombie_villager', 'zombie_villager', 'skeleton', 'spider', 'cave_spider',
  'creeper', 'enderman', 'witch', 'pillager', 'vindicator', 'illusioner',
  'evoker', 'ravager', 'phantom', 'drowned', 'husk', 'stray',
  'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin',
  'silverfish', 'elder_guardian', 'guardian', 'shulker', 'vex',
  'warden', 'bogged', 'breeze'
]

function findNearestHostile (bot, range) {
  var r = range || 16
  var nearest = null
  var nearestDist = Infinity
  Object.values(bot.entities).forEach(function (e) {
    if (!e.name) return
    if (e.type === 'player') return  // never attack players
    if (HOSTILE_MOBS.indexOf(e.name) === -1) return
    if (!e.position) return
    var dist = bot.entity.position.distanceTo(e.position)
    if (dist < r && dist < nearestDist) {
      nearest = e
      nearestDist = dist
    }
  })
  return nearest
}

function startAttackNearest (bot) {
  stopAll(bot)
  // keep scanning for targets every 1s
  bot._armyInterval = setInterval(function () {
    if (bot.pvp.target) return
    var t = findNearestHostile(bot, 20)
    if (t) {
      console.log('[Army] ' + bot.username + ' -> attacking ' + t.name)
      bot.pvp.attack(t)
    }
  }, 1000)
}

function startGuard (bot, idx) {
  stopAll(bot)
  // Save guard position with per-bot offset so they don't stack
  var off = getBotOffset(idx || 1, 2)
  var gx = Math.round(bot.entity.position.x + off.dx)
  var gy = Math.round(bot.entity.position.y)
  var gz = Math.round(bot.entity.position.z + off.dz)
  bot._guardPos = { x: gx, y: gy, z: gz }

  bot._armyInterval = setInterval(function () {
    // Attack nearby hostiles first
    if (bot.pvp.target) return
    var t = findNearestHostile(bot, 10)
    if (t) {
      console.log('[Army] ' + bot.username + ' guard -> attacking ' + t.name)
      bot.pvp.attack(t)
      return
    }
    // Return to guard position if drifted
    var dist = bot.entity.position.distanceTo(bot._guardPos)
    if (dist > 5) {
      bot.pathfinder.setGoal(new goals.GoalNear(gx, gy, gz, 1), false)
    }
  }, 1000)
}

function startEscort (bot, targetName, idx) {
  stopAll(bot)
  bot._followTarget = targetName
  bot._armyInterval = setInterval(function () {
    // Attack nearby hostiles first
    if (!bot.pvp.target) {
      var t = findNearestHostile(bot, 12)
      if (t) { bot.pvp.attack(t); return }
    }
    // If no combat - follow commander
    if (!bot.pvp.target) {
      var target = findPlayer(bot, bot._followTarget)
      if (!target) return
      var off = getBotOffset(idx, 3)
      var tx = Math.round(target.position.x + off.dx)
      var tz = Math.round(target.position.z + off.dz)
      bot.pathfinder.setGoal(new goals.GoalNear(tx, target.position.y, tz, 1), true)
    }
  }, 1000)
}

function stopAll (bot) {
  if (bot._armyInterval) {
    clearInterval(bot._armyInterval)
    bot._armyInterval = null
  }
  try { bot.pvp.stop() } catch (_) {}
  try { bot.pathfinder.setGoal(null) } catch (_) {}
}

// ─── Gear system ─────────────────────────────────────────────────────────────

var WEAPONS  = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword','netherite_axe','diamond_axe','iron_axe']
var HELMETS  = ['netherite_helmet','diamond_helmet','iron_helmet','golden_helmet','chainmail_helmet','leather_helmet']
var CHESTS   = ['netherite_chestplate','diamond_chestplate','iron_chestplate','golden_chestplate','chainmail_chestplate','leather_chestplate']
var LEGS     = ['netherite_leggings','diamond_leggings','iron_leggings','golden_leggings','chainmail_leggings','leather_leggings']
var BOOTS    = ['netherite_boots','diamond_boots','iron_boots','golden_boots','chainmail_boots','leather_boots']
var OFFHANDS = ['torch','shield','totem_of_undying']

function findBestItem (bot, nameList) {
  for (var n = 0; n < nameList.length; n++) {
    var item = bot.inventory.items().find(function (it) { return it.name === nameList[n] })
    if (item) return item
  }
  return null
}

function equipGear (bot, slot) {
  var mode = (slot || 'all').toLowerCase()

  function tryEquip (item, destination, delay) {
    if (!item) return
    setTimeout(function () {
      bot.equip(item, destination, function (err) {
        if (err) console.log('[Army] ' + bot.username + ' equip ' + item.name + ' -> ' + destination + ' ERR: ' + err.message)
        else console.log('[Army] ' + bot.username + ' equipped ' + item.name + ' -> ' + destination)
      })
    }, delay || 0)
  }

  if (mode === 'all' || mode === 'sword' || mode === 'weapon') {
    tryEquip(findBestItem(bot, WEAPONS), 'hand', 0)
  }
  if (mode === 'all' || mode === 'offhand' || mode === 'torch') {
    tryEquip(findBestItem(bot, OFFHANDS), 'off-hand', 200)
  }
  if (mode === 'all' || mode === 'armor') {
    tryEquip(findBestItem(bot, HELMETS), 'head',  400)
    tryEquip(findBestItem(bot, CHESTS),  'torso', 600)
    tryEquip(findBestItem(bot, LEGS),    'legs',  800)
    tryEquip(findBestItem(bot, BOOTS),   'feet',  1000)
  }
}

// ─── Formation system ─────────────────────────────────────────────────────────
// Calculates each bot's offset slot relative to commander's yaw direction.
// index is 1-based (Beer_1 = 1)

function formUp (bot, formation, senderName, idx) {
  stopAll(bot)
  const commander = findPlayer(bot, senderName)
  if (!commander) {
    console.log('[Army] ' + bot.username + ': commander not in range, using bot position as center')
  }

  // Use commander position if visible, otherwise offset from own position by slot
  const base = commander ? commander.position : bot.entity.position
  const yawSrc = commander || bot.entity

  // mineflayer entity.yaw: 0=south(+Z), PI/2=east(+X), PI=north(-Z), -PI/2=west(-X)
  // forward = direction player faces, right = 90deg clockwise from forward
  const yaw = yawSrc.yaw || 0
  const fwdX =  Math.sin(yaw)   // forward X component
  const fwdZ = -Math.cos(yaw)   // forward Z component  (south = +Z when yaw=0... wait mineflayer: yaw=0 → looking south +Z)
  const rgtX =  Math.cos(yaw)   // right = rotate forward 90° CW
  const rgtZ =  Math.sin(yaw)

  const i = idx - 1  // 0-based slot
  let ox = 0, oz = 0  // offset from commander

  console.log('[Army] form yaw=' + yaw.toFixed(2) + ' base=' + Math.round(base.x) + ',' + Math.round(base.y) + ',' + Math.round(base.z))

  const f = (formation || 'line').toLowerCase()

  if (f === 'line') {
    // Shoulder-to-shoulder, spread sideways
    const slot = i - Math.floor(ARMY_SIZE / 2)
    ox = rgtX * slot * 2
    oz = rgtZ * slot * 2

  } else if (f === 'column') {
    // 2-wide march column behind commander
    var col = i % 2          // 0 = left, 1 = right
    var row = Math.floor(i / 2) + 1
    var side = col === 0 ? -1 : 1
    ox = fwdX * -(row * 2) + rgtX * side
    oz = fwdZ * -(row * 2) + rgtZ * side

  } else if (f === 'circle') {
    // Ring around commander
    const angle = (2 * Math.PI / ARMY_SIZE) * i
    const radius = 4
    ox = Math.cos(angle) * radius
    oz = Math.sin(angle) * radius

  } else if (f === 'square') {
    // 4 columns of 5
    const cols = 4
    const col = i % cols
    const row = Math.floor(i / cols)
    ox = rgtX * (col - cols / 2 + 0.5) * 2 + fwdX * -(row + 1) * 2
    oz = rgtZ * (col - cols / 2 + 0.5) * 2 + fwdZ * -(row + 1) * 2

  } else {
    console.log('[Army] ' + bot.username + ': unknown formation ' + f)
    return
  }

  const tx = Math.round(base.x + ox)
  const ty = Math.round(base.y)
  const tz = Math.round(base.z + oz)
  bot.pathfinder.setGoal(new goals.GoalNear(tx, ty, tz, 1), false)
  console.log('[Army] ' + bot.username + ' -> form ' + f + ' at ' + tx + ',' + ty + ',' + tz)

  // Once arrived, look same direction as commander
  var lookInterval = setInterval(function () {
    var dist = bot.entity.position.distanceTo({ x: tx, y: ty, z: tz })
    if (dist <= 2) {
      clearInterval(lookInterval)
      try { bot.look(yaw, 0, true) } catch (_) {}
    }
  }, 500)
}

// ─── Spawn one soldier ────────────────────────────────────────────────────────

function spawnSoldier (index) {
  const username = ARMY_PREFIX + '_' + index

  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: username,
    version: VERSION,
    auth: 'offline'
  })

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvp)

  bot.once('spawn', function () {
    const { Movements } = require('mineflayer-pathfinder')
    const mcData = require('minecraft-data')(bot.version)
    const movements = new Movements(bot, mcData)
    movements.allowSprinting = true
    movements.canDig = false
    bot.pathfinder.setMovements(movements)
    console.log('[Army] ' + username + ' spawned')
    // Auto-equip after 3s delay (give_gear.js may still be running)
    setTimeout(function () { equipGear(bot, 'all') }, 3000)
    // Debug: log ALL nearby entities so we know their real type/name
    setTimeout(function () {
      var all = Object.values(bot.entities).filter(function(e) { return e.type !== 'player' && e.name })
      console.log('[Army] ' + username + ' entities(' + all.length + '): ' + all.slice(0,10).map(function(e){ return e.name+'('+e.type+')' }).join(', '))
    }, 5000)
    // Keepalive: slowly look around every 8s to seem alive (no sneak animation)
    var lookStep = 0
    setInterval(function () {
      try {
        var angles = [0, Math.PI / 4, Math.PI / 2, Math.PI / 4, 0, -Math.PI / 4, -Math.PI / 2, -Math.PI / 4]
        var yaw = (bot.entity.yaw || 0) + angles[lookStep % angles.length]
        bot.look(yaw, 0, false)
        lookStep++
      } catch (_) {}
    }, 8000)
  })

  bot.on('chat', function (sender, message) {
    const isCommander = sender === MAIN_BOT_NAME || sender === COMMANDER
    if (!isCommander) return

    let cmd, args

    // !squad#N <cmd>  — command to specific bot by number
    const soloMatch = message.match(/^!squad#(\d+)\s+(\S+)(.*)/)
    if (soloMatch) {
      const targetIdx = parseInt(soloMatch[1], 10)
      if (targetIdx !== index) return
      cmd = soloMatch[2].toLowerCase()
      args = soloMatch[3].trim().split(/\s+/).filter(Boolean)
      handleCommand(bot, cmd, args, sender, index)
      return
    }

    // !squad#N-M <cmd>  — command to range of bots e.g. !squad#3-8 come
    const rangeMatch = message.match(/^!squad#(\d+)-(\d+)\s+(\S+)(.*)/)
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1], 10)
      const to   = parseInt(rangeMatch[2], 10)
      if (index < from || index > to) return
      cmd = rangeMatch[3].toLowerCase()
      args = rangeMatch[4].trim().split(/\s+/).filter(Boolean)
      handleCommand(bot, cmd, args, sender, index)
      return
    }

    // !squad <cmd>  — command to ALL bots
    if (message.indexOf('!squad ') !== 0) return
    const parts = message.slice(7).trim().split(/\s+/)
    cmd  = parts[0].toLowerCase()
    args = parts.slice(1)
    handleCommand(bot, cmd, args, sender, index)
  })

  bot.on('error', function (err) {
    console.error('[Army] ' + username + ' error: ' + err.message)
  })

  bot.on('kicked', function (reason) {
    console.log('[Army] ' + username + ' kicked: ' + reason)
  })

  bot.on('end', function () {
    console.log('[Army] ' + username + ' disconnected')
  })

  soldiers.push(bot)
}

// ─── Launch all soldiers with stagger ────────────────────────────────────────

console.log('[Army] Launching ' + ARMY_SIZE + ' soldiers -> ' + HOST + ':' + PORT + ' (v' + VERSION + ')')
console.log('[Army] Main bot name: "' + MAIN_BOT_NAME + '"')
console.log('[Army] Commanders: "' + MAIN_BOT_NAME + '" or "' + COMMANDER + '"')
console.log('[Army] Commands (type in Minecraft chat with prefix !squad):')
console.log('         !squad follow            — follow commander')
console.log('         !squad come              — come to commander now')
console.log('         !squad stop              — stop all')
console.log('         !squad guard             — attack nearby hostiles')
console.log('         !squad attack <name>     — attack player or mob')
console.log('         !squad say <text>        — all soldiers say text')
console.log('         !squad form line         — shoulder-to-shoulder sideways')
console.log('         !squad form column       — single file behind you')
console.log('         !squad form circle       — ring around you')
console.log('         !squad form square       — 4x5 block behind you')
console.log('         !squad#N <cmd>           — command to single bot e.g. !squad#5 come')
console.log('         !squad#N-M <cmd>         — command to range e.g. !squad#1-10 stop')
console.log('')

for (let i = 1; i <= ARMY_SIZE; i++) {
  setTimeout(function (idx) {
    return function () { spawnSoldier(idx) }
  }(i), i * SPAWN_DELAY_MS)
}
