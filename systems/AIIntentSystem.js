'use strict'

const { formatAssistantBriefing } = require('../features/assistantBriefing')
const { IntentTypes } = require('../core/IntentTypes')
const { parsePlayerMessage } = require('../commands/parsePlayerMessage')

/**
 * OpenAI Assistants + NVIDIA fallback + chat-oriented helpers.
 * Assistant **tool calls** enqueue {@link ../core/IntentTypes} on `deps.brain` instead of calling movement/defend directly.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ config: any, state: any, utils: any, actions: any, voice?: any, brain?: import('../core/BotBrain').BotBrain }} deps
 */
function createAI (bot, deps) {
  const { config, state, utils, actions } = deps
  const brain = deps.brain || null
  const { log, getPlayerEntity } = utils

  const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '')

  let currentThreadId = null
  let assistantInFlight = false
  let threadExchangeCount = 0

  function openAiHeaders () {
    return {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2'
    }
  }

  async function openAiFetch (path, { method = 'GET', body } = {}) {
    const opts = { method, headers: openAiHeaders() }
    if (body !== undefined) opts.body = JSON.stringify(body)
    const res = await fetch(`${OPENAI_BASE}${path}`, opts)
    const text = await res.text().catch(() => '')
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    if (!res.ok) {
      const msg = data?.error?.message || text?.slice(0, 400) || res.statusText
      const err = new Error(`OpenAI ${res.status}: ${msg}`)
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  }

  /**
   * Legacy helper: returns canonical `command` string for chat tools / smoke tests.
   * Delegates to `commands/parsePlayerMessage` (registry); does not use substring matching.
   * @param {string} messageLower — typically full trimmed message (often lowercased by caller)
   */
  function parseCommand (messageLower) {
    const raw = String(messageLower || '').trim()
    if (!raw) return null
    const p = parsePlayerMessage(raw, { source: 'chat', defendCapable: true })
    return p ? p.command : null
  }

  /**
   * @param {{ chatCompact?: boolean }} [opts]
   */
  function getBotContext (opts = {}) {
    if (opts.chatCompact) {
      return formatAssistantBriefing(bot, state, { maxChars: 360, radius: 18 })
    }
    return formatAssistantBriefing(bot, state)
  }

  async function askNvidia (userMessage) {
    if (!config.nvidiaApiKey) {
      return 'Нет ключа ИИ: задай OPENAI_API_KEY + ASSISTANT_ID или NVIDIA_API_KEY в .env.'
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.aiTimeoutMs)

    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.nvidiaApiKey}`
        },
        body: JSON.stringify({
          model: config.nvidiaModel,
          messages: [
            {
              role: 'system',
              content:
                'Ты помощник в Майнкрафте. Отвечай коротко, по-русски. Команды игрок задаёт текстом: следуй, стой, иди ко мне — бот обрабатывает их отдельно, ты только болтаешь.'
            },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 80
        }),
        signal: controller.signal
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        log('NVIDIA API HTTP error:', response.status, errText.slice(0, 250))
        return 'Сервер ИИ сейчас недоступен.'
      }

      const data = await response.json()
      const answer = data?.choices?.[0]?.message?.content?.trim()
      if (!answer) return 'Не понял, повтори коротко.'
      return answer
    } catch (err) {
      if (err.name === 'AbortError') {
        log('NVIDIA API timeout')
        return 'Долго думаю. Повтори запрос.'
      }
      log('NVIDIA API error:', err.message)
      return 'Ошибка ИИ. Попробуй снова.'
    } finally {
      clearTimeout(timeout)
    }
  }

  async function initThread () {
    const data = await openAiFetch('/v1/threads', { method: 'POST', body: {} })
    if (!data?.id) throw new Error('OpenAI threads: нет id в ответе')
    currentThreadId = data.id
    threadExchangeCount = 0
    log('OpenAI thread:', currentThreadId)
    return currentThreadId
  }

  async function ensureThread () {
    if (currentThreadId) return currentThreadId
    return initThread()
  }

  function extractAssistantTextFromMessage (msg) {
    const c = msg?.content
    if (typeof c === 'string') return c.trim()
    if (!Array.isArray(c)) return ''
    const parts = []
    for (const block of c) {
      if (block?.type === 'text' && block.text?.value) parts.push(block.text.value)
    }
    return parts.join('\n').trim()
  }

  async function fetchLatestAssistantReply (threadId) {
    const lim = config.openAiFetchMessagesLimit
    const data = await openAiFetch(`/v1/threads/${threadId}/messages?order=desc&limit=${lim}`)
    const list = data?.data || []
    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      if (m.role !== 'assistant') continue
      const t = extractAssistantTextFromMessage(m)
      if (t) return t
    }
    return null
  }

  async function getRun (threadId, runId) {
    return openAiFetch(`/v1/threads/${threadId}/runs/${runId}`)
  }

  async function submitToolOutputs (threadId, runId, toolOutputs) {
    return openAiFetch(`/v1/threads/${threadId}/runs/${runId}/submit_tool_outputs`, {
      method: 'POST',
      body: { tool_outputs: toolOutputs }
    })
  }

  function requireBrainForTools () {
    if (!brain || typeof brain.pushIntent !== 'function') {
      throw new Error('BotBrain missing: Assistant tools require deps.brain with pushIntent')
    }
  }

  /**
   * @param {import('../core/BotBrain').BotBrain} b
   * @param {object} intent
   */
  function pushToolIntent (b, intent) {
    b.pushIntent(intent)
  }

  /**
   * @param {object} toolCall
   * @param {string} [spokeUsername]
   */
  async function executeToolCall (toolCall, spokeUsername) {
    requireBrainForTools()

    const id = toolCall?.id || 'unknown'
    const fn = toolCall?.function?.name || ''
    let args = {}
    const rawArgs = toolCall?.function?.arguments
    if (rawArgs && typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs)
      } catch {
        return { tool_call_id: id, output: JSON.stringify({ ok: false, error: 'invalid_arguments_json' }) }
      }
    }

    const out = (msg) => ({ tool_call_id: id, output: String(msg).slice(0, 8000) })

    try {
      switch (fn) {
        case 'stop': {
          pushToolIntent(brain, { type: IntentTypes.BOT_STOP })
          return out('Остановился, режим idle (намерение поставлено в очередь).')
        }
        case 'followPlayer': {
          const name =
            args.player_name ||
            args.playerName ||
            spokeUsername ||
            state.targetUsername ||
            config.allowedUsers[0] ||
            null
          if (!name) {
            return out('Нет имени игрока: укажи player_name или пиши из игры, чтобы взять ник из чата.')
          }
          const ent = getPlayerEntity(name)
          if (!ent) return out(`Игрок "${name}" не в зоне загрузки (нет entity).`)
          pushToolIntent(brain, { type: IntentTypes.MOVEMENT_SET_FOLLOW, targetUsername: name })
          return out(`Следую за ${name}.`)
        }
        case 'moveTo': {
          const x = args.x
          const y = args.y
          const z = args.z
          const range = args.range != null ? Number(args.range) : 2
          pushToolIntent(brain, {
            type: IntentTypes.NAV_GOTO,
            x,
            y,
            z,
            range: Number.isFinite(range) ? range : 2
          })
          return out(`Навигация к (~${x}, ${y}, ${z}) поставлена в очередь.`)
        }
        case 'craftGear': {
          pushToolIntent(brain, { type: IntentTypes.GAMEPLAY_CRAFT_GEAR })
          return out('Крафт снаряды: намерение поставлено в очередь.')
        }
        case 'toggleFlight': {
          const raw = args.enable
          const en = raw === true || raw === 'true' || raw === 1 || raw === '1'
          pushToolIntent(brain, { type: IntentTypes.GAMEPLAY_TOGGLE_FLIGHT, enable: en })
          return out(en ? 'Полёт вкл. (очередь).' : 'Полёт выкл. (очередь).')
        }
        case 'attackEntity': {
          const entityName =
            args.entity_name ||
            args.entityName ||
            args.target_name ||
            args.target ||
            spokeUsername ||
            null
          if (!entityName || typeof entityName !== 'string') {
            return out(JSON.stringify({ ok: false, error: 'need entity_name / entityName / target' }))
          }
          const strategy =
            typeof args.strategy === 'string' ? args.strategy : args.strategy ? String(args.strategy) : 'aggressive'
          pushToolIntent(brain, { type: IntentTypes.COMBAT_ENGAGE_ENTITY, entityName, strategy })
          return out(JSON.stringify({ ok: true, queued: true, entityName, strategy }))
        }
        case 'stopAttack': {
          pushToolIntent(brain, { type: IntentTypes.COMBAT_STOP_ATTACK })
          return out('Атака остановлена (очередь).')
        }
        case 'patrolMode': {
          if (!config.defendPatrolEnabled) {
            return out(
              JSON.stringify({
                ok: false,
                error: 'patrol_disabled',
                hint: 'Patrol is frozen by default. Set PATROL_ENABLED=1 to enable.'
              })
            )
          }
          pushToolIntent(brain, { type: IntentTypes.DEFEND_PATROL, params: args })
          return out(JSON.stringify({ ok: true, queued: true, tool: 'patrolMode' }))
        }
        case 'defendPoint': {
          pushToolIntent(brain, { type: IntentTypes.DEFEND_POINT, params: args })
          return out(JSON.stringify({ ok: true, queued: true, tool: 'defendPoint' }))
        }
        case 'defendEntity': {
          pushToolIntent(brain, { type: IntentTypes.DEFEND_ENTITY, params: args })
          return out(JSON.stringify({ ok: true, queued: true, tool: 'defendEntity' }))
        }
        case 'defendStop': {
          pushToolIntent(brain, { type: IntentTypes.DEFEND_STOP })
          return out(JSON.stringify({ ok: true, queued: true, tool: 'defendStop' }))
        }
        case 'getEnvironment': {
          if (typeof actions.getEnvironment !== 'function') {
            return out(JSON.stringify({ ok: false, error: 'getEnvironment не подключён (index.js actions).' }))
          }
          const snapshot = actions.getEnvironment()
          return out(typeof snapshot === 'string' ? snapshot : String(snapshot))
        }
        default:
          return out(JSON.stringify({ ok: false, error: `unknown_tool:${fn}` }))
      }
    } catch (e) {
      log('[assistant tool]', fn, e.message)
      return out(`Ошибка инструмента ${fn}: ${e.message}`)
    }
  }

  function waitForRunTerminal (threadId, runId, spokeUsername) {
    const pollMin = config.openAiPollIntervalMs
    const pollMax = config.openAiPollMaxMs
    const maxMs = config.openAiAssistantTimeoutMs
    const deadline = Date.now() + maxMs

    return new Promise((resolve, reject) => {
      let settled = false
      let busy = false
      let pollDelay = pollMin
      let consecutiveWaits = 0
      let nextTimer = null

      const cleanup = () => {
        if (settled) return
        settled = true
        if (nextTimer) clearTimeout(nextTimer)
        nextTimer = null
        clearTimeout(hardStop)
      }

      const hardStop = setTimeout(() => {
        if (settled) return
        cleanup()
        reject(new Error('Assistant: таймаут ожидания run'))
      }, maxMs + pollMax + 500)

      const scheduleNext = () => {
        if (settled) return
        nextTimer = setTimeout(() => {
          nextTimer = null
          void tick()
        }, pollDelay)
      }

      const tick = async () => {
        if (settled || busy) return
        if (Date.now() > deadline) {
          cleanup()
          reject(new Error('Assistant: дедлайн run'))
          return
        }
        busy = true
        try {
          const run = await getRun(threadId, runId)
          const status = run?.status

          if (status === 'completed') {
            if (config.openAiLogUsage && run?.usage != null) {
              try {
                log('[assistant usage]', JSON.stringify(run.usage))
              } catch (_) {
                log('[assistant usage]', String(run.usage))
              }
            }
            cleanup()
            resolve(run)
            return
          }

          if (status === 'failed' || status === 'cancelled' || status === 'expired') {
            cleanup()
            const why = run?.last_error?.message || status
            reject(new Error(`Assistant run: ${why}`))
            return
          }

          if (status === 'requires_action') {
            const ra = run.required_action
            const type = ra?.type
            if (type !== 'submit_tool_outputs') {
              cleanup()
              reject(new Error(`Assistant: неподдерживаемый required_action: ${type}`))
              return
            }
            const toolCalls = ra.submit_tool_outputs?.tool_calls || []
            if (!toolCalls.length) {
              cleanup()
              reject(new Error('Assistant: requires_action без tool_calls'))
              return
            }
            const outputs = []
            for (let i = 0; i < toolCalls.length; i++) {
              outputs.push(await executeToolCall(toolCalls[i], spokeUsername))
            }
            await submitToolOutputs(threadId, runId, outputs)
            pollDelay = pollMin
            consecutiveWaits = 0
          } else {
            consecutiveWaits += 1
            const exp = Math.min(consecutiveWaits - 1, 12)
            pollDelay = Math.min(pollMax, Math.round(pollMin * Math.pow(1.35, Math.max(0, exp))))
          }
        } catch (e) {
          cleanup()
          reject(e)
          return
        } finally {
          busy = false
        }
        if (!settled) scheduleNext()
      }

      void tick()
    })
  }

  async function askAssistant (userMessage, { spokeUsername, autonomous } = {}) {
    if (!config.openaiApiKey || !config.assistantId) {
      const hint =
        'Задай OPENAI_API_KEY и ASSISTANT_ID в .env для Assistant API, либо NVIDIA_API_KEY для простого чата.'
      if (config.nvidiaApiKey) {
        const ctx = `${getBotContext({ chatCompact: !autonomous })}\n`
        const body = autonomous ? `${ctx}[Автономная реплика]\n${userMessage}` : `${ctx}Игрок (${spokeUsername || '?'}): ${userMessage}`
        return askNvidia(body)
      }
      return autonomous ? null : hint
    }

    if (assistantInFlight) {
      return autonomous ? null : 'Уже обрабатываю прошлый запрос — напиши через секунду.'
    }
    assistantInFlight = true

    try {
      const threadId = await ensureThread()
      const ctxLine = getBotContext({ chatCompact: !autonomous })
      const fullContent = autonomous
        ? `[Автономная реплика напарника — коротко по-русски для голоса, 1–2 предложения]\n${ctxLine}\nЗадача:\n${userMessage}`
        : `${ctxLine}\nИгрок в чате: ${spokeUsername || 'unknown'}\nСообщение: ${userMessage}`

      await openAiFetch(`/v1/threads/${threadId}/messages`, {
        method: 'POST',
        body: { role: 'user', content: fullContent }
      })

      const runData = await openAiFetch(`/v1/threads/${threadId}/runs`, {
        method: 'POST',
        body: { assistant_id: config.assistantId }
      })
      const runId = runData?.id
      if (!runId) throw new Error('OpenAI runs: нет id')

      await waitForRunTerminal(threadId, runId, spokeUsername || (autonomous ? 'autonomous' : undefined))

      const reply = await fetchLatestAssistantReply(threadId)
      const resetAfter = config.openAiThreadResetAfterMessages
      if (resetAfter > 0) {
        threadExchangeCount += 1
        if (threadExchangeCount >= resetAfter) {
          currentThreadId = null
          threadExchangeCount = 0
          log('[assistant] тред сброшен после', resetAfter, 'ответов (экономия контекста)')
        }
      }
      if (reply) return reply
      return autonomous ? null : 'Готово.'
    } catch (e) {
      log('Assistant API error:', e.message)
      if (autonomous) return null
      if (e.status === 401) return 'OpenAI: неверный или просроченный API-ключ.'
      return `Ошибка ассистента: ${e.message}`.slice(0, 240)
    } finally {
      assistantInFlight = false
    }
  }

  return {
    askAssistant,
    askNvidia,
    getBotContext,
    parseCommand,
    initThread
  }
}

module.exports = createAI
