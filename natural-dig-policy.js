/**
 * Политика копки для mineflayer-pathfinder: сначала A* ищет ОБХОД (дорогая копка = digCost),
 * но если обхода нет — можно прорубить только «сырьевой» ландшафт и дерево, не трогая постройки.
 *
 * См. readme mineflayer-pathfinder: digCost, thinkTimeout.
 */

function isBuiltWoodOrMechanism(name) {
  if (!name) return true
  if (name.includes('mosaic')) return true
  if (name.includes('plank')) return true
  if (name.endsWith('_stairs') || name.endsWith('_slab')) return true
  if (name.includes('door') || name.includes('trapdoor')) return true
  if (name.includes('fence') || name.includes('_gate')) return true
  if (name.includes('sign') || name.includes('hanging_sign')) return true
  if (name.includes('pressure_plate') || name.includes('button')) return true
  if (name.includes('sapling')) return true
  return false
}

/** Постройки, руду, медь, обсидиан и т.п. — не копаем в плане пути */
function isProtectedFromPathBreak(name) {
  if (!name || name === 'air') return true
  if (isBuiltWoodOrMechanism(name)) return true
  if (name.endsWith('_wall')) return true
  if (name === 'glass' || name === 'tinted_glass' || name.includes('stained_glass')) return true
  if (name.includes('glass_pane') || name === 'iron_bars') return true
  if (/_ore$/i.test(name)) return true
  if (/glazed_terracotta/i.test(name)) return true
  if (/_bricks$/i.test(name) || /_tiles$/i.test(name)) return true
  if (name.includes('copper') && !name.includes('raw')) return true
  if (/_concrete$/i.test(name) && !name.includes('powder')) return true
  if (name === 'obsidian' || name === 'crying_obsidian') return true
  if (name.includes('spawner')) return true
  if (name === 'ancient_debris') return true
  if (name.includes('command_block')) return true
  if (name.includes('barrier')) return true
  if (name.includes('bedrock')) return true
  return false
}

const TERRAIN_EARTH = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt', 'mud',
  'clay', 'gravel', 'sand', 'red_sand', 'soul_sand', 'soul_soil',
  'snow_block', 'powder_snow', 'farmland', 'dirt_path'
])

const TERRAIN_STONE = new Set([
  'stone', 'cobblestone', 'mossy_cobblestone',
  'granite', 'diorite', 'andesite',
  'deepslate', 'cobbled_deepslate', 'polished_deepslate', 'tuff', 'calcite', 'dripstone_block',
  'pointed_dripstone',
  'sandstone', 'chiseled_sandstone', 'cut_sandstone', 'smooth_sandstone',
  'red_sandstone', 'chiseled_red_sandstone', 'cut_red_sandstone', 'smooth_red_sandstone',
  'blackstone', 'polished_blackstone', 'basalt', 'smooth_basalt',
  'netherrack', 'crimson_nylium', 'warped_nylium', 'warped_wart_block', 'nether_wart_block',
  'end_stone', 'purpur_block', 'purpur_pillar'
])

const TREE_AND_ORGANIC = new Set([
  'vine', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'mangrove_roots', 'muddy_mangrove_roots', 'cocoa', 'bamboo', 'bamboo_block',
  'azalea', 'flowering_azalea', 'bee_nest', 'beehive',
  'brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem',
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'glow_lichen', 'sweet_berry_bush', 'snow_layer'
])

function isTreeOrStem(name) {
  if (!name) return false
  if (/_log$/.test(name)) return true
  if (/_stem$/.test(name) || /_hyphae$/.test(name)) return true
  if (/_leaves$/.test(name)) return true
  if (/_wood$/.test(name)) return true
  return false
}

/**
 * Разрешено ли pathfinder'у ломать этот блок как часть маршрута (после того как обход оценён дороже).
 */
function isPathBreakAllowed(name) {
  if (!name || name === 'air') return false
  if (isProtectedFromPathBreak(name)) return false
  if (TREE_AND_ORGANIC.has(name)) return true
  if (isTreeOrStem(name)) return true
  if (TERRAIN_EARTH.has(name)) return true
  if (TERRAIN_STONE.has(name)) return true
  if (name.endsWith('_concrete_powder')) return true
  if (name.endsWith('_terracotta') && !name.includes('glazed')) return true
  return false
}

/**
 * Блоки, которые pathfinder может ломать как часть A* (дорого через digCost).
 * Каменный ландшафт (TERRAIN_STONE) исключён: иначе бот рубит один камень вместо шага/паркурa.
 * Ручная барьерная копка см. barrierBreakPriority (камень — почти никогда).
 */
function isPathfinderBreakAllowed(name) {
  if (!isPathBreakAllowed(name)) return false
  if (TERRAIN_STONE.has(name)) return false
  return true
}

/**
 * Приоритет для РУЧНОЙ барьерной копки при залипании: брёвна / листва / земля выше декоративной травы.
 * Камень (TERRAIN_STONE): по умолчанию не копаем (PATH_BARRIER_STONE_PRIORITY=0) — только repath / обход.
 * Чем выше число — тем раньше выбираем блок при равной необходимости.
 */
const BARRIER_LOW_PRIORITY_FLORA = new Set([
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'glow_lichen', 'sweet_berry_bush', 'snow_layer',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'torchflower', 'pitcher_plant',
  'sunflower', 'rose_bush', 'peony', 'lilac'
])

function barrierBreakPriority(name) {
  if (!name || name === 'air') return 0
  if (!isPathBreakAllowed(name)) return 0
  /** Камень при залипании: только если явно разрешено (иначе только repath / обход). */
  if (TERRAIN_STONE.has(name)) {
    const p = parseInt(process.env.PATH_BARRIER_STONE_PRIORITY || '0', 10)
    return Number.isFinite(p) ? p : 0
  }
  if (/_log$/i.test(name) || /_stem$/i.test(name) || /_hyphae$/i.test(name) || /_wood$/i.test(name)) {
    return 100
  }
  if (/_leaves$/i.test(name)) return 92
  if (TERRAIN_EARTH.has(name)) return 82
  if (name.includes('vine') || name.includes('mushroom_block') || name === 'mushroom_stem' || name === 'cocoa') {
    return 76
  }
  if (BARRIER_LOW_PRIORITY_FLORA.has(name)) return 25
  return 65
}

/**
 * Все копаемые блоки, кроме разрешённых, попадают в blocksCantBreak.
 */
function applyPathBreakBlacklist(movement, mcData) {
  const blocks = mcData.blocksArray || []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block?.diggable) continue
    if (isPathfinderBreakAllowed(block.name)) continue
    movement.blocksCantBreak.add(block.id)
  }
}

/** @deprecated используй isPathBreakAllowed */
const isNaturalObstacleBreakAllowed = isPathBreakAllowed

module.exports = {
  isPathBreakAllowed,
  isPathfinderBreakAllowed,
  applyPathBreakBlacklist,
  barrierBreakPriority,
  isNaturalObstacleBreakAllowed,
  /** старое имя для movement.js */
  applyNaturalDigBlacklist: applyPathBreakBlacklist
}
