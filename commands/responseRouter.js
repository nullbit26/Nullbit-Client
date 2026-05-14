'use strict'
const { DELIVERY_CHANNELS, DELIVERY_POLICY } = require('./deliveryPolicy')

/**
 * @param {any} ctx
 * @param {{ username: string }} exec
 * @param {{ response?: { channel?: string, text?: string } }} result
 */
function sendDispatchResponse (ctx, exec, result) {
  const response = result && result.response
  if (!response || !response.text) return

  const text = String(response.text || '')
  const channel = response.channel || DELIVERY_CHANNELS.CHAT
  const policy = DELIVERY_POLICY[channel] || DELIVERY_POLICY.chat

  if (channel === DELIVERY_CHANNELS.CHAT) {
    ctx.safeChat(text)
    return
  }

  const canWhisper = typeof ctx.bot?.whisper === 'function'
  if (policy.preferWhisper && canWhisper) {
    try {
      ctx.bot.whisper(exec.username, text)
      return
    } catch (_) {}
  }
  if (policy.allowFallbackToChat) {
    ctx.safeChat(text)
  }
}

module.exports = { sendDispatchResponse }
