'use strict'

const DELIVERY_CHANNELS = /** @type {const} */ ({
  CHAT: 'chat',
  WHISPER: 'whisper',
  WHISPER_PREFERRED: 'whisperPreferred'
})

/**
 * Centralized response delivery rules:
 * - chat: always chat
 * - whisper: strict whisper, fallback to chat if whisper unavailable/error
 * - whisperPreferred: whisper first, fallback to chat
 */
const DELIVERY_POLICY = /** @type {const} */ ({
  chat: { preferWhisper: false, allowFallbackToChat: true },
  whisper: { preferWhisper: true, allowFallbackToChat: true },
  whisperPreferred: { preferWhisper: true, allowFallbackToChat: true }
})

module.exports = {
  DELIVERY_CHANNELS,
  DELIVERY_POLICY
}
