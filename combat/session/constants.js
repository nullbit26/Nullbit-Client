'use strict'

const CFG = {
  ATTACK_RANGE: 3.2,
  SPRINT_RANGE: 7,
  STRAFE_RANGE: 2.5,
  /** Длительность шага стрейфа (мс), внутри ±джиттер. */
  STRAFE_STEP_MIN_MS: 280,
  STRAFE_STEP_MAX_MS: 520,
  CRIT_JUMP_DELAY_MS: 200, // быстрее реакция
  ATTACK_COOLDOWN_MS: 650, // чуть больше запас
  /** Короткий сброс спринта перед ударом (аналог части «w-tap» меты 1.9+); 0 = отключить. */
  SPRINT_RESET_BEFORE_HIT_MS: 45,
  SHIELD_RAISE_DIST: 3.0,
  LOW_HEALTH: 10,
  CRITICAL_HEALTH: 6,
  /** Ниже — внутренний «defensive»: не преследуем, пьём зелья, щит; выше — снова полный бой. */
  RECOVER_ENTER_HEALTH: 10,
  RECOVER_EXIT_HEALTH: 15,
  RECOVER_POTION_TRY_MS: 2200,
  ARROW_DODGE_DIST: 8,
  COMBAT_TIMEOUT_MS: 90_000,
  TICK_MS: 100, // 50мс слишком часто для pathfinder; атака по кулдауну 650мс
  PREDICTION_TICKS: 3,
  /** Дальний бой: не лезть в GoalFollow(2) — держим дистанцию для лука/арбалета. */
  RANGED_GOAL_FOLLOW_DIST: 8,
  /** Цель заметно выше и почти над нами — идти в сторону кольцом, не под столб. */
  RANGED_TOWER_DY_MIN: 2.35,
  RANGED_UNDER_MAX_HD: 5.5,
  RANGED_RING_DIST: 11,
  /** Цель убегает по горизонтали — смещение к флангу (бег+стрельба под углом). */
  RANGED_FLEE_FLANK_HD: 0.14,
  RANGED_FLANK_SIDE: 6,
  RANGED_FLANK_NEAR_RANGE: 4,
  /** Мин. пауза после окончания выстрела до следующего (мс) — серверный кулдаун + запас. */
  RANGED_VOLLEY_PAD_BOW_MS: 220,
  RANGED_VOLLEY_PAD_CROSSBOW_MS: 320,
  /** Не пытаться стрелять дальше (лук теряет смысл). */
  RANGED_VOLLEY_MAX_DIST: 48,
  /** Ближе этого к цели — только ближний бой (мобы дёргаются → ложный «убегает» и лук в упор). */
  RANGED_MELEE_ONLY_MAX_DIST: 6.5,
  /** «Убегает» включает лук только если цель и так не в зоне меча. */
  RANGED_FLEE_MIN_DIST: 9,
  /** Пауза после сброса движения перед прицеливанием (мс) — физика успокаивается. */
  RANGED_STABILIZE_MS: 100,
  /** Упреждение: грубая «скорость стрелы» по горизонтали (блоков за тик) для оценки времени полёта. */
  RANGED_ARROW_SPEED_BPT_BOW: 1.9,
  RANGED_ARROW_SPEED_BPT_CROSSBOW: 2.25,
  RANGED_LEAD_MIN_FLIGHT_TICKS: 4,
  RANGED_LEAD_MAX_FLIGHT_TICKS: 28,
  /** Доля тиков натяжки, добавляемых к упреждению (цель движется, пока тянем). */
  RANGED_LEAD_WINDUP_FRACTION_BOW: 0.42,
  RANGED_LEAD_WINDUP_FRACTION_CROSSBOW: 0.5,
  /** Режим strategy === 'archer': только лук/арбалет, дистанция ~12–16, отход при < 8. */
  ARCHER_IDEAL_DIST: 14,
  ARCHER_MIN_DIST: 8,
  ARCHER_RETREAT_DIST: 12
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = { CFG, sleep }
