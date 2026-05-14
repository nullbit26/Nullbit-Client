/** 1 / true / yes / on (без учёта регистра, trim). BOM в .env не мешает, если значение без кавычек. */
function envFlagTrue (val) {
  if (val == null) return false
  const s = String(val).trim().replace(/^\uFEFF/, '').toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

const path = require('path')
const ConfigManager = require('./config/ConfigManager')
if (!ConfigManager.loaded) {
  ConfigManager.load({ envPath: path.join(__dirname, '.env') })
}

const config = {
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || 'MINI_KOSH',
  version: process.env.MC_VERSION || '1.21.11',
  auth: process.env.MC_AUTH || 'offline',
  /** Microsoft / online mode: только из `.env`, не хардкодить. */
  mcPassword: process.env.MC_PASSWORD || '',

  // Comma-separated list in .env: ALLOWED_USERS=Steve,Alex
  allowedUsers: (process.env.ALLOWED_USERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Начальный состав пати из `.env` (через запятую). Алиасы: `PARTY`, `COMBAT_FRIENDS`, `BOT_FRIENDS`.
   * После первого запуска список хранится в `data/party.json` и правится командами `party add|remove|list|clear`.
   */
  partySeedUsers: (process.env.PARTY || process.env.COMBAT_FRIENDS || process.env.BOT_FRIENDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
  nvidiaModel: process.env.NVIDIA_MODEL || '',

  /**
   * OpenAI Assistants API v2 (см. `ai.js` → `askAssistant`).
   * Ключ и ID клади ТОЛЬКО в корневой файл `.env` (не в config.js и не в репозиторий).
   * Имя ключа: `OPENAI_API_KEY` или запасное `CHATGPT_API_KEY`. Ассистент: `ASSISTANT_ID` или `OPENAI_ASSISTANT_ID`.
   */
  openaiApiKey: process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY || '',
  assistantId: (process.env.ASSISTANT_ID || process.env.OPENAI_ASSISTANT_ID || '').trim(),
  /** Интервал GET …/runs/{id} (мс) — старт backoff; дальше растёт до openAiPollMaxMs */
  openAiPollIntervalMs: Number(process.env.OPENAI_POLL_MS || 1000),
  /** Верхняя граница задержки между GET …/runs/{id} при поллинге (мс) */
  openAiPollMaxMs: Number(process.env.OPENAI_POLL_MAX_MS || 8000),
  /** Максимум ожидания одного run (мс), включая tool-calls */
  openAiAssistantTimeoutMs: Number(process.env.OPENAI_ASSISTANT_TIMEOUT_MS || 180000),
  /**
   * После стольких успешных ответов ассистента подряд в одном треде — сброс треда (новый тред со следующего ask).
   * 0 = не сбрасывать (один тред на всю сессию). Рекомендация для длинных сессий: 20–40.
   */
  openAiThreadResetAfterMessages: Number(process.env.OPENAI_THREAD_RESET_AFTER_MESSAGES || 0),
  /** GET …/messages?limit= — сколько последних сообщений запрашивать за ответ (меньше = меньше трафика) */
  openAiFetchMessagesLimit: Math.min(100, Math.max(2, Number(process.env.OPENAI_FETCH_MESSAGES_LIMIT || 5))),
  /** Логировать run.usage после completed (если поле есть в ответе API) */
  openAiLogUsage: process.env.OPENAI_LOG_USAGE === '0' ? false : true,

  aiCooldownMs: Number(process.env.AI_COOLDOWN_MS || 4000),
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 12000),
  voiceEnabled: process.env.VOICE_ENABLED !== '0',
  voicePythonBin: process.env.VOICE_PYTHON_BIN || 'python',
  voiceModel: process.env.VOICE_MODEL || 'v5_ru',
  voiceSpeaker: process.env.VOICE_SPEAKER || 'aidar',
  voiceSampleRate: Number(process.env.VOICE_SAMPLE_RATE || 48000),
  voiceOutputDevice: process.env.VOICE_OUTPUT_DEVICE || 'CABLE Input',
  voiceDeviceId: (() => {
    const raw = process.env.VOICE_DEVICE_ID
    if (raw === undefined || String(raw).trim() === '') return 6
    const n = Number(raw)
    return Number.isFinite(n) ? n : 6
  })(),
  /** VOICE_KEEP_TEMP_WAV=1 — не удалять временный WAV после отправки в SVC (отладка). */
  voiceKeepTempWav: process.env.VOICE_KEEP_TEMP_WAV === '1',
  /** Ожидание UDP Simple Voice Chat перед отправкой речи (мс). */
  voiceUdpReadyTimeoutMs: Number(process.env.VOICE_UDP_READY_MS || 20000),
  /**
   * Пауза между UDP Mic-кадрами (мс). По умолчанию 18 — чуть меньше 20 ms кадра Opus, меньше рывков из‑за задержки отправки.
   * VOICE_OPUS_FRAME_MS пусто/невалидно → берётся встроенный default в simple-voice-chat-udp.js (18).
   */
  voiceOpusFrameSpacingMs: Number(process.env.VOICE_OPUS_FRAME_MS || 18),
  /** Пустых Opus-кадров тишины после фразы. VOICE_TAIL_SILENCE_FRAMES (по умолчанию 8). */
  voiceTailSilenceFrames: Number(process.env.VOICE_TAIL_SILENCE_FRAMES || 8),
  /** Пустых Opus-кадров перед речью (прогрев джиттер-буфера SVC). VOICE_UDP_PREAMBLE_FRAMES, по умолчанию 4; 0 — выкл. */
  voiceUdpPreambleFrames: Number(process.env.VOICE_UDP_PREAMBLE_FRAMES || 4),
  /** Пауза (мс) после последнего аудио кадра перед хвостом тишины. VOICE_POST_AUDIO_GAP_MS */
  voicePostAudioGapMs: Number(process.env.VOICE_POST_AUDIO_GAP_MS || 200),

  /**
   * Simple Voice Chat (Fabric): после TCP нужен UDP + AES auth. Иначе в клиенте «вилка» (Disconnected).
   * VOICECHAT_UDP=0 — не слать request_secret и не открывать UDP.
   */
  voiceChatUdpEnabled: process.env.VOICECHAT_UDP !== '0',
  /** Число в voicechat:request_secret (должно совпадать с voicechat_compatibility_version мода на сервере). */
  voiceChatCompatibilityVersion: Number(process.env.VOICECHAT_COMPAT || 20),
  /** VOICECHAT_DEBUG_CHANNELS=1 — логировать все custom_payload channel. */
  voiceChatDebugPayloads: process.env.VOICECHAT_DEBUG_CHANNELS === '1',
  /**
   * VOICE_FORCE_LOCAL_UDP=1|true|yes|on — UDP голоса на 127.0.0.1; host из voicechat:secret не используется.
   * Порт по-прежнему из секрета.
   */
  voiceForceLocalUdpHost: envFlagTrue(process.env.VOICE_FORCE_LOCAL_UDP),
  /**
   * Если MC_HOST выглядит как loopback, а в секрете внешний host (ply.gg и т.д.) — UDP на 127.0.0.1 без .env.
   * VOICE_UDP_AUTO_LOOPBACK=0 — выключить эвристику.
   */
  voiceUdpAutoLoopbackExternal: process.env.VOICE_UDP_AUTO_LOOPBACK !== '0',

  guardScanIntervalTicks: Number(process.env.GUARD_SCAN_TICKS || 8),
  /**
   * FOLLOW_AUTO_PROTECT=0 — в режиме follow не вступать в защиту цели автоматически.
   * По умолчанию включено: follow работает как "следуй и прикрывай".
   */
  followAutoProtect: process.env.FOLLOW_AUTO_PROTECT !== '0',
  guardFollowDistance: Number(process.env.GUARD_FOLLOW_DISTANCE || 3),
  followDistance: Number(process.env.FOLLOW_DISTANCE || 3),
  comeNearDistance: Number(process.env.COME_NEAR_DISTANCE || 1),
  guardMobDistance: Number(process.env.GUARD_MOB_DISTANCE || 10),
  /**
   * Ring patrol (`patrolMode`) и «patrol»-ноги у defend-point выключены по умолчанию (экспериментально заморожено).
   * Включить: PATROL_ENABLED=1 (или DEFEND_PATROL_ENABLED=1).
   */
  defendPatrolEnabled: process.env.PATROL_ENABLED === '1' || process.env.DEFEND_PATROL_ENABLED === '1',
  /** В guard: не реже этого интервала (тиков) проверять anti-stuck (≥ stuckCheckTicks). */
  guardStuckCheckTicks: Number(process.env.GUARD_STUCK_CHECK_TICKS || 14),

  // Pathfinder anti-stuck tuning (см. movement.js; env переопределяет)
  /** Реже принудительный repath к цели — меньше конфликтов с цепочкой partial A* (см. debug path_result). */
  followRefreshTicks: Number(process.env.FOLLOW_REFRESH_TICKS || 12),
  minFollowRepathDistance: Number(process.env.MIN_FOLLOW_REPATH_DISTANCE || 3),
  /**
   * Прямой бег к цели без узлов A* (mineflayer allowFreeMotion). У внешних углов зданий часто ВТИСКИВАЕТ в стену.
   * Включай только если нужно: PATH_ALLOW_FREE_MOTION=1
   */
  pathAllowFreeMotion: process.env.PATH_ALLOW_FREE_MOTION === '1',

  /**
   * При залипании с isCollidedHorizontally — короткий шаг вбок, затем новый путь (обход выпуклого угла).
   * 0 = выключить. ~160–220 мс обычно достаточно.
   */
  pathCornerSidestepMs: Number(process.env.PATH_CORNER_SIDESTEP_MS || 200),
  /** Короче боковой шаг при path stall без коллизии (мс). 0 = как pathCornerSidestepMs. */
  pathStallMicroSidestepMs: Number(process.env.PATH_STALL_MICRO_SIDESTEP_MS || 120),

  /** Короткий прыжок вместе с sidestep (подъём на уступ в 1 блок). Включить: PATH_CORNER_SIDESTEP_JUMP=1 */
  pathCornerSidestepJump: process.env.PATH_CORNER_SIDESTEP_JUMP === '1',

  /** Чем больше — реже проверка anti-stuck (меньше ложных срабатываний на углах). */
  stuckCheckTicks: Number(process.env.STUCK_CHECK_TICKS || 11),
  stuckMoveThreshold: Number(process.env.STUCK_MOVE_THRESHOLD || 0.12),
  /** «Почти не сдвинулся» для углов: множитель к stuckMoveThreshold */
  stuckMoveLenience: Number(process.env.STUCK_MOVE_LENIENCE || 1.42),
  /** Гориз. скорость ниже — считаем залип на рёбрах (даже без isCollidedHorizontally) */
  stuckCornerVelocityMax: Number(process.env.STUCK_CORNER_VEL_MAX || 0.048),
  /** Тиков подряд без смещения при isMoving() до stall-escape (больше — терпимее углы / 1 блок). */
  pathStallEscapeTicks: Number(process.env.PATH_STALL_ESCAPE_TICKS || 16),
  /** Минимальное смещение позиции за тик stall, чтобы считать прогресс. */
  pathStallProgressEpsilon: Number(process.env.PATH_STALL_PROGRESS_EPS || 0.15),
  /** Не чаще одного corner-escape за это время (мс) */
  pathCornerEscapeCooldownMs: Number(process.env.PATH_CORNER_ESCAPE_COOLDOWN_MS || 2800),
  /** После path_stall recovery не копить stall-тики (мс). */
  stallRecoveryGraceMs: Number(process.env.STALL_RECOVERY_GRACE_MS || 900),
  /** Минимум между любыми handleStuckRecovery (мс). */
  recoveryGlobalMinMs: Number(process.env.RECOVERY_GLOBAL_MIN_MS || 2200),
  /** Минимум между anti_stuck и path_stall в разных направлениях (мс). */
  recoveryCrossContextMinMs: Number(process.env.RECOVERY_CROSS_CONTEXT_MS || 4000),
  /** Последний шаг — жёсткий сброс; 2–4 — ручная копка барьера (листва/брёвна) */
  maxStuckCountBeforeNudge: Number(process.env.MAX_STUCK_BEFORE_NUDGE || 5),
  loopGuardTicks: Number(process.env.LOOP_GUARD_TICKS || 10),
  loopMoveThreshold: Number(process.env.LOOP_MOVE_THRESHOLD || 0.025),
  debugMovement: process.env.DEBUG_MOVEMENT === '1',
  useBaritoneFollow: false,

  /**
   * Nav-assist: raycast-прыжок, векторный стрейф при затыке, срез углов, анти-zero velocity (NAV_ASSIST=0 — выкл).
   */
  navAssistEnabled: process.env.NAV_ASSIST !== '0',
  navAssistRayDistance: Number(process.env.NAV_ASSIST_RAY_BLOCKS || 1.2),
  /** Окно «почти стоим по XZ»: дольше в траве не триггерит recovery на каждые 2 с. */
  navAssistSmartStuckWindowMs: Number(process.env.NAV_ASSIST_STUCK_MS || 2800),
  /** Смещение по горизонтали от якоря — уже этого достаточно, чтобы обнулить таймер (трава, микродрифт). */
  navAssistSmartStuckEpsilon: Number(process.env.NAV_ASSIST_STUCK_EPS || 0.2),
  /** Ближе к цели на эту Дельту (3D) — тоже сброс якоря, даже если XZ мал. */
  navAssistSmartStuckGoalGain: Number(process.env.NAV_ASSIST_STUCK_GOAL_GAIN || 0.07),
  /** Считать «долго тихо по земле» перед stuck (мс), вместе с коллизией. */
  navAssistSmartLowSpeedHoldMs: Number(process.env.NAV_ASSIST_SLOW_MS || 700),
  navAssistVelocityStallMs: Number(process.env.NAV_ASSIST_VEL_STALL_MS || 300),
  navAssistVelocityEps: Number(process.env.NAV_ASSIST_VEL_EPS || 0.022),
  navAssistRecoverBackMs: Number(process.env.NAV_ASSIST_BACK_MS || 140),
  navAssistRecoverStrafeMs: Number(process.env.NAV_ASSIST_STRAFE_MS || 320),
  /** После стрейфа pathfinder паузирует ровно back+strafe+tail (нет окна без клавиш и рывков). */
  navAssistRecoverPauseTailMs: Number(process.env.NAV_ASSIST_PAUSE_TAIL_MS || 95),
  /** Дальность бокового рейкаста при обходе дерева/стены (ширина ствола + запас). */
  navAssistCollideProbeBlocks: Number(process.env.NAV_ASSIST_COLLIDE_PROBE || 0.92),
  /** Если вперёд раньше этого расстояния твёрдое препятствие — при малых hSpeed можно включить peel (стрф + без forward). */
  navAssistPeelBarrierBlocks: Number(process.env.NAV_ASSIST_PEEL_BARRIER || 0.38),
  navAssistPeelSlowSpeed: Number(process.env.NAV_ASSIST_PEEL_SLOW || 0.068),
  navAssistCornerCutCooldownMs: Number(process.env.NAV_ASSIST_CORNER_MS || 380),
  navAssistSmartRecoverCooldownMs: Number(process.env.NAV_ASSIST_RECOVER_CD_MS || 5200),

  /** A*: штраф за соседние со всех сторон твёрдые блоки (имитация «стена на pad шире»). 0 — выкл. */
  pathWallPaddingCost: Number(process.env.PATH_WALL_PADDING_COST || 0.38),
  pathWallPaddingCap: Number(process.env.PATH_WALL_PADDING_CAP || 2.9),

  /**
   * Отскок от стены: WASD + нет XZ-скорости + луч в направлении движения < WALL_STICK_RAY — пауза pathfinder, back+jump.
   * WALL_STICK_BOUNCE=0 — выкл.
   */
  wallStickBounceEnabled: process.env.WALL_STICK_BOUNCE !== '0',
  wallStickArmMs: Number(process.env.WALL_STICK_ARM_MS || 220),
  wallStickVelEps: Number(process.env.WALL_STICK_VEL_EPS || 0.02),
  wallStickRayBlocks: Number(process.env.WALL_STICK_RAY || 0.3),
  wallStickPfPauseMs: Number(process.env.WALL_STICK_PF_PAUSE_MS || 520),
  wallStickBackJumpMs: Number(process.env.WALL_STICK_BACKJUMP_MS || 140),
  wallStickBounceCooldownMs: Number(process.env.WALL_STICK_BOUNCE_CD_MS || 4200),
  wallStickSprintAfterMs: Number(process.env.WALL_STICK_SPRINT_AFTER_MS || 1000),
  wallStickSprintPfPauseMs: Number(process.env.WALL_STICK_SPRINT_PAUSE_MS || 440),
  wallStickSprintDriveMs: Number(process.env.WALL_STICK_SPRINT_MS || 260),
  wallStickSprintEscapeCooldownMs: Number(process.env.WALL_STICK_SPRINT_CD_MS || 5500),

  /** При вкл. nav-assist старый tickPathStallEscape/handleAntiStuck по умолчанию отключены; env=1 включает обратно */
  navAssistLegacyAntiStuck: process.env.NAV_ASSIST_LEGACY_ANTISTUCK === '1',
  navAssistLegacyPathStall: process.env.NAV_ASSIST_LEGACY_STALL === '1',

  /** 0 = выключено. Значение 0.05 — типичный фикс из issue #223 (hitbox vs сервер). */
  physicsHitboxInflate: Number(process.env.PHYS_HITBOX_INFLATE ?? 0.05),

  /**
   * PATH_CARDINAL_ONLY=1 — только осевые шаги в A* (без диагоналей). Часто надёжнее у препятствий (mineflayer-pathfinder #310).
   */
  pathCardinalOnly: process.env.PATH_CARDINAL_ONLY === '1',
  /** Больше время — лучше находит длинный обход вокруг больших препятствий */
  pathThinkTimeoutMs: Number(process.env.PATH_THINK_TIMEOUT_MS || 24000),
  /** Больше мс на тик A* → меньше событий partial подряд, плавнее прыжок/движение (логи: path_result ms). */
  pathTickTimeoutMs: Number(process.env.PATH_TICK_TIMEOUT_MS || 150),
  /** После noPath/timeout — принудительный пересчёт цели */
  pathRepublishOnFailure: process.env.PATH_REPUBLISH_ON_FAILURE !== '0',
  /** Минимум тиков между попытками recovery по path_update (noPath/timeout/partial). Больше — реже спам в логах. */
  pathNoPathRepathCooldownTicks: Number(process.env.PATH_NOPATH_COOLDOWN_TICKS || 48),
  /**
   * Минимум мс между полными handleStuckRecovery только для noPath (тот же interrupt+repath мало что меняет).
   * 0 = выключить. Dig по-прежнему разблокируется на каждом noPath в events.
   */
  pathNoPathRecoveryMinMs: Number(process.env.PATH_NOPATH_RECOVERY_MIN_MS || 5200),
  /** partial от A* — не сбрасывать путь (иначе спам recovery и залипание). noPath/timeout — как раньше. */
  pathRecoverOnPartial: process.env.PATH_RECOVER_ON_PARTIAL === '1',
  /**
   * PATH_DIG_NATURAL=0 — pathfinder не планирует копку (только обход).
   * Иначе можно копать только природные блоки (см. natural-dig-policy.js): брёвна, листва, лианы…
   */
  pathAllowDigNatural: process.env.PATH_DIG_NATURAL !== '0',
  /**
   * Сначала A* без копки (canDig=false); при noPath/timeout включается копка природы (см. events path_update).
   * Выключить старое поведение: PATH_DIG_PREFER_WALK=0
   */
  pathDigPreferWalk: process.env.PATH_DIG_PREFER_WALK !== '0',
  /**
   * Доп. стоимость копки природы в A*. Чем ВЫШЕ — тем охотнее длинный обход вместо рубки.
   * Чем ниже — тем чаще путь пойдёт через слом (после того как A* «подумает» в лимитах think/tick timeout).
   */
  /** Высокое значение: A* сильнее предпочитает обход; копка только если обход слишком дорог / нет пути */
  pathDigNaturalCost: Number(process.env.PATH_DIG_NATURAL_COST || 26),
  /** Задержка перед repath на шаге 1 anti-stuck (мс) */
  pathRepathAfterStuckMs: Number(process.env.PATH_REPATH_AFTER_STUCK_MS || 120),
  /**
   * После repath подождать столько мс и, если всё ещё упёрся — сразу пробовать барьерную копку
   * (не ждать второго полного цикла stuckCheck). 0 = выключить.
   */
  pathFastBarrierAfterRepathMs: Number(process.env.PATH_FAST_BARRIER_AFTER_REPATH_MS || 160),
  /**
   * На втором шаге anti-stuck — вручную копнуть блок впереди (трава или дерево по тем же правилам).
   * PATH_MINE_BARRIER_ON_STUCK=0 или старый PATH_MINE_VEG_ON_STUCK=0 — выключить.
   */
  pathMineBarrierWhenStuck:
    process.env.PATH_MINE_BARRIER_ON_STUCK !== '0' &&
    process.env.PATH_MINE_VEG_ON_STUCK !== '0',

  /**
   * Чат-команда «атакуй …»: v1 видимость — только сущности в пределах этой дистанции (блоки).
   * COMMAND_ATTACK_MAX_DIST: 8–96, по умолчанию 32.
   */
  commandAttackMaxDistanceBlocks: Math.max(8, Math.min(96, Number(process.env.COMMAND_ATTACK_MAX_DIST || 32))),
  /**
   * Если две подходящие цели отличаются по дистанции не больше чем на ε (блоки) — отказ `target_ambiguous`.
   * COMMAND_ATTACK_AMBIGUITY_EPS: 0.1–8, по умолчанию 1.5.
   */
  commandAttackAmbiguityEpsilonBlocks: Math.max(0.1, Math.min(8, Number(process.env.COMMAND_ATTACK_AMBIGUITY_EPS || 1.5))),
  /**
   * Явный override атаки во время defend: фразы из `attack_direct` в {@link ../commands/commandRegistry.js}
   * (RU: «бросай/снимай/отмени защиту и атакуй …», «принудительно атакуй …»; EN: `drop defend and attack …`, `attack force …` и т.д.).
   * COMMAND_ATTACK_DEFEND_OVERRIDE=0 — запретить все такие override (поведение как у обычной атаки под охраной).
   */
  commandAttackDefendOverrideEnabled: process.env.COMMAND_ATTACK_DEFEND_OVERRIDE !== '0',

  /** AUTO_RECONNECT=1 — после обрыва сессии снова вызывать `start()` (см. `systems/RecoverySystem.js`). */
  autoReconnectEnabled: process.env.AUTO_RECONNECT === '1',

  reconnectMaxDelayMs: Number(process.env.RECONNECT_MAX_DELAY_MS || 30000),

  /**
   * Bus-driven flee/heal ({@link ../systems/CombatSystem}): при активной сессии attackEntity и низком HP
   * — стоп боя, core FLEE, `nav:goto` прочь от угрозы, поедание еды из инвентаря.
   * COMBAT_FLEE=0 — выключить.
   */
  combatFleeEnabled: process.env.COMBAT_FLEE !== '0',
  /** Абсолютный порог «бежим»: срабатывает если HP <= этого ИЛИ HP/maxHealth <= ratio. */
  combatFleeCriticalHp: Number(process.env.COMBAT_FLEE_CRITICAL_HP || 6),
  combatFleeCriticalRatio: Number(process.env.COMBAT_FLEE_CRITICAL_RATIO || 0.3),
  /**
   * Выход из FLEE по HP: порог = min(maxHealth, max(safeHp, ceil(maxHealth * safeRatio))).
   * По умолчанию на 20 HP это 16; только `ratio` без абсолюта больше не используется отдельно (см. CombatSystem).
   */
  combatFleeSafeHp: Number(process.env.COMBAT_FLEE_SAFE_HP || 12),
  combatFleeSafeRatio: Number(process.env.COMBAT_FLEE_SAFE_RATIO || 0.8),
  /**
   * Нет еды/зелий: не выходить из FLEE сразу — держаться min мс ИЛИ пока угрозы не дальше CLEAR блоков.
   * COMBAT_FLEE_MIN_MS_NO_HEAL: 5000–15000, по умолчанию 8000.
   */
  combatFleeMinMsNoHeal: Math.max(5000, Math.min(15000, Number(process.env.COMBAT_FLEE_MIN_MS_NO_HEAL || 8000))),
  /** Все учтённые угрозы дальше этого радиуса (блоки) — «достаточно далеко» для выхода без хила. */
  combatFleeClearThreatBlocks: Number(process.env.COMBAT_FLEE_CLEAR_THREAT_BLOCKS || 14),
  /**
   * Мин. горизонтальная дистанция до угрозы у якоря flee-цели (блоки), плюс запас под GoalNear range.
   * COMBAT_FLEE_MIN_THREAT_BLOCKS: 6–12, по умолчанию 8.
   */
  combatFleeMinThreatBlocks: Math.max(6, Math.min(12, Number(process.env.COMBAT_FLEE_MIN_THREAT_BLOCKS || 8))),
  /** Доп. вынос по направлению «от врага» поверх текущей дистанции (блоки). */
  combatFleeNavDistance: Number(process.env.COMBAT_FLEE_NAV_DISTANCE || 20),
  /** Допуск прибытия к якорю flee для GoalNear (1–3). */
  combatFleeGoalArrivalRange: Math.max(1, Math.min(3, Number(process.env.COMBAT_FLEE_GOAL_RANGE || 1.5))),
  /** Мин. дистанция до ближайшей угрозы (блоки), чтобы пить/есть во время FLEE (COMBAT_FLEE_HEAL_SAFE_BLOCKS). */
  combatFleeHealSafeBlocks: Number(process.env.COMBAT_FLEE_HEAL_SAFE_BLOCKS) || 16,
  /** Радиус учета количества "близких" угроз для pressure-модели (блоки). */
  combatFleeNearbyThreatRadiusBlocks: Math.max(6, Math.min(24, Number(process.env.COMBAT_FLEE_NEARBY_RADIUS || 14))),
  /** Дистанция, ниже которой nearest threat добавляет высокий immediate danger score. */
  combatFleeImmediateDangerBlocks: Math.max(6, Math.min(20, Number(process.env.COMBAT_FLEE_IMMEDIATE_DANGER_BLOCKS || 11))),
  /** Сколько мс после агро считать его "свежим" в pressure-модели. */
  combatFleeAggroFreshMs: Math.max(1000, Math.min(20000, Number(process.env.COMBAT_FLEE_AGGRO_FRESH_MS || 6000))),
  /** Горизонт учета давности агро (мс) для recentAggroScore. */
  combatFleeAggroHorizonMs: Math.max(3000, Math.min(60000, Number(process.env.COMBAT_FLEE_AGGRO_HORIZON_MS || 12000))),
  /** Вес одной записи агро-памяти в recentAggroScore. */
  combatFleeAggroEntryWeight: Math.max(0.05, Math.min(0.8, Number(process.env.COMBAT_FLEE_AGGRO_ENTRY_WEIGHT || 0.22))),
  /** Включить risk-based вход в FLEE поверх hard HP-порогов. */
  combatFleeRetreatScoreEnabled: process.env.COMBAT_FLEE_RETREAT_SCORE !== '0',
  /** Порог retreat score для входа в FLEE (если не сработал hard HP trigger). Выше — реже уходить «по толпе» без критичного HP. */
  combatFleeRetreatScoreThreshold: Math.max(0.4, Math.min(4, Number(process.env.COMBAT_FLEE_RETREAT_SCORE_THRESHOLD || 1.95))),
  /**
   * Risk-FLEE только если HP/maxHealth ≤ этого порога (например 0.94 ≈ не убегать от одной толпы при почти полном HP).
   * COMBAT_FLEE_RETREAT_HP_RATIO_MAX=1 — выключить ограничение (только порог score).
   */
  combatFleeRetreatRiskHpRatioMax: (() => {
    const raw = process.env.COMBAT_FLEE_RETREAT_HP_RATIO_MAX
    if (raw === undefined || String(raw).trim() === '') return 0.94
    const v = Number(raw)
    if (!Number.isFinite(v) || v >= 1) return 1
    return Math.max(0.5, Math.min(0.99, v))
  })(),
  /** Веса компонентов retreat score. */
  combatFleeRetreatHpWeight: Math.max(0.2, Math.min(3, Number(process.env.COMBAT_FLEE_RETREAT_HP_WEIGHT || 1.0))),
  combatFleeRetreatPressureWeight: Math.max(0.2, Math.min(3, Number(process.env.COMBAT_FLEE_RETREAT_PRESSURE_WEIGHT || 0.58))),
  combatFleeRetreatNearbyWeight: Math.max(0, Math.min(1.5, Number(process.env.COMBAT_FLEE_RETREAT_NEARBY_WEIGHT || 0.14))),
  combatFleeRetreatImmediateDangerBonus: Math.max(0, Math.min(1.5, Number(process.env.COMBAT_FLEE_RETREAT_IMMEDIATE_BONUS || 0.2))),
  /** Мин. рост combinedPressure за тик, чтобы считать spike (меньше — реже ложные replan при стабильной толпе). */
  combatFleePressureSpikeDelta: Math.max(0.35, Math.min(3, Number(process.env.COMBAT_FLEE_PRESSURE_SPIKE_DELTA || 1.1))),
  /** Лимиты recentAggroScore для heal/recover/exit решений. */
  combatFleeHealAggroMaxScore: Math.max(0.05, Math.min(2, Number(process.env.COMBAT_FLEE_HEAL_AGGRO_MAX || 0.5))),
  combatFleeRecoverAggroMaxScore: Math.max(0.05, Math.min(2, Number(process.env.COMBAT_FLEE_RECOVER_AGGRO_MAX || 0.35))),
  combatFleeExitAggroMaxScore: Math.max(0.05, Math.min(2, Number(process.env.COMBAT_FLEE_EXIT_AGGRO_MAX || 0.22))),
  /** Мин. время непрерывно «безопасно для выхода» перед выходом из FLEE / реэнгейджем (мс). */
  combatFleeExitHysteresisMs: Math.max(400, Math.min(6000, Number(process.env.COMBAT_FLEE_EXIT_HYSTERESIS_MS || 1800))),
  /** Условный порог "высокого" recentAggroPressure для telemetry/debug. */
  combatFleeRecentAggroHighScore: Math.max(0.05, Math.min(2, Number(process.env.COMBAT_FLEE_AGGRO_HIGH_SCORE || 0.55))),
  /** Фаза BREAK_CONTACT пока nearest угроза ближе этого порога (блоки). */
  combatFleeBreakContactBlocks: Math.max(4, Math.min(14, Number(process.env.COMBAT_FLEE_BREAK_CONTACT_BLOCKS || 9))),
  /** Для RECOVER: nearest угроза должна быть дальше этого порога (блоки), либо угроза считается far. */
  combatFleeRecoverThreatBlocks: Math.max(8, Math.min(28, Number(process.env.COMBAT_FLEE_RECOVER_THREAT_BLOCKS || 18))),
  /** Минимум времени FLEE (мс), прежде чем допускать RECOVER фазу. */
  combatFleeStabilizeMinMs: Math.max(0, Math.min(12000, Number(process.env.COMBAT_FLEE_STABILIZE_MIN_MS || 2200))),
  /** Sticky flee plan: удерживать план минимум это время (мс), если есть прогресс. */
  combatFleePlanHoldMs: Math.max(800, Math.min(12000, Number(process.env.COMBAT_FLEE_PLAN_HOLD_MS || 2600))),
  /** Sticky flee plan: принудительный replan при превышении TTL плана (мс). */
  combatFleePlanMaxMs: Math.max(1500, Math.min(20000, Number(process.env.COMBAT_FLEE_PLAN_MAX_MS || 7000))),
  /** Минимальный интервал между не-экстренными replans (мс). */
  combatFleePlanMinReplanMs: Math.max(300, Math.min(8000, Number(process.env.COMBAT_FLEE_PLAN_MIN_REPLAN_MS || 1200))),
  /** Экстренный replan если nearest угроза схлопнулась до этой дистанции (блоки). */
  combatFleeEmergencyReplanDistance: Math.max(4, Math.min(16, Number(process.env.COMBAT_FLEE_EMERGENCY_REPLAN_DISTANCE || 8))),
  /** Сколько безопасных flee-тиков подряд нужно до старта consume. */
  combatFleeHealSafeWindowTicks: Math.max(1, Math.min(6, Number(process.env.COMBAT_FLEE_HEAL_SAFE_WINDOW_TICKS || 2))),
  /** Мин. пауза после nav:goto перед consume (мс). */
  combatFleeHealAfterNavDelayMs: Math.max(800, Math.min(6000, Number(process.env.COMBAT_FLEE_HEAL_AFTER_NAV_DELAY_MS || 3000))),
  /** Базовый backoff после неудачного consume (мс), затем растет по step до max. */
  combatFleeHealConsumeBackoffMs: Math.max(300, Math.min(3000, Number(process.env.COMBAT_FLEE_HEAL_BACKOFF_MS || 1000))),
  combatFleeHealConsumeBackoffStepMs: Math.max(200, Math.min(1800, Number(process.env.COMBAT_FLEE_HEAL_BACKOFF_STEP_MS || 700))),
  combatFleeHealConsumeBackoffMaxMs: Math.max(1200, Math.min(10000, Number(process.env.COMBAT_FLEE_HEAL_BACKOFF_MAX_MS || 4500))),
  /** Локальный cooldown контроллера после попыток consume (мс). */
  combatFleeHealSuccessCooldownMs: Math.max(200, Math.min(3000, Number(process.env.COMBAT_FLEE_HEAL_SUCCESS_CD_MS || 700))),
  combatFleeHealFailCooldownMs: Math.max(600, Math.min(5000, Number(process.env.COMBAT_FLEE_HEAL_FAIL_CD_MS || 1400))),
  /**
   * В attackEntity: defensive melee — GoalFollow держит дистанцию от цели (6–11), по умолчанию 8.
   * COMBAT_DEFENSIVE_MELEE_FOLLOW_DIST
   */
  combatDefensiveMeleeFollowDist: Math.max(6, Math.min(11, Number(process.env.COMBAT_DEFENSIVE_MELEE_FOLLOW_DIST || 8))),
  /** Период physicsTick для обновления flee-цели и попытки съесть (4–40). */
  combatFleeRetickTicks: Math.max(4, Math.min(40, Number(process.env.COMBAT_FLEE_RETICK_TICKS || 12))),

  /** Разрешить toggleFlight без creative (например серверный /fly в survival). Осторожно: только gravity на клиенте. */
  flyAllowNonCreative: process.env.FLY_ALLOW_NON_CREATIVE === '1'
}

module.exports = config
