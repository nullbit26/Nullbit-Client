// Gear config — what each bot gets
// Format: 'item_name' or 'item_name:count'
// Roles:
//   Beer_1  - Beer_10  : crossbowmen (10 bots)
//   Beer_11 - Beer_34  : spearmen with shield (24 bots)  — spear = iron_sword (closest to spear in vanilla)
//   Beer_35 - Beer_40  : swordsmen with shield (6 bots)

var COMMON = [
  'iron_helmet',
  'iron_chestplate',
  'iron_leggings',
  'iron_boots',
  'cooked_beef:64',
  'torch:16'
]

var CROSSBOWMAN = COMMON.concat([
  'crossbow',
  'arrow:128',
  'shield'
])

var SPEARMAN = COMMON.concat([
  'iron_sword',   // acts as spear
  'shield',
  'arrow:32'
])

var SWORDSMAN = COMMON.concat([
  'iron_sword',
  'shield',
  'arrow:16'
])

module.exports = {
  default: COMMON,

  // ── Crossbowmen: Beer_1 - Beer_10 ──
  Beer_1:  CROSSBOWMAN,
  Beer_2:  CROSSBOWMAN,
  Beer_3:  CROSSBOWMAN,
  Beer_4:  CROSSBOWMAN,
  Beer_5:  CROSSBOWMAN,
  Beer_6:  CROSSBOWMAN,
  Beer_7:  CROSSBOWMAN,
  Beer_8:  CROSSBOWMAN,
  Beer_9:  CROSSBOWMAN,
  Beer_10: CROSSBOWMAN,

  // ── Spearmen: Beer_11 - Beer_34 ──
  Beer_11: SPEARMAN,
  Beer_12: SPEARMAN,
  Beer_13: SPEARMAN,
  Beer_14: SPEARMAN,
  Beer_15: SPEARMAN,
  Beer_16: SPEARMAN,
  Beer_17: SPEARMAN,
  Beer_18: SPEARMAN,
  Beer_19: SPEARMAN,
  Beer_20: SPEARMAN,
  Beer_21: SPEARMAN,
  Beer_22: SPEARMAN,
  Beer_23: SPEARMAN,
  Beer_24: SPEARMAN,
  Beer_25: SPEARMAN,
  Beer_26: SPEARMAN,
  Beer_27: SPEARMAN,
  Beer_28: SPEARMAN,
  Beer_29: SPEARMAN,
  Beer_30: SPEARMAN,
  Beer_31: SPEARMAN,
  Beer_32: SPEARMAN,
  Beer_33: SPEARMAN,
  Beer_34: SPEARMAN,

  // ── Swordsmen: Beer_35 - Beer_40 ──
  Beer_35: SWORDSMAN,
  Beer_36: SWORDSMAN,
  Beer_37: SWORDSMAN,
  Beer_38: SWORDSMAN,
  Beer_39: SWORDSMAN,
  Beer_40: SWORDSMAN,
}
