'use strict'
const { DELIVERY_CHANNELS } = require('./deliveryPolicy')
const { COMMAND_LOG_CODES } = require('./commandLogCodes')

/**
 * @typedef {'chat' | 'whisper' | 'whisperPreferred'} ResponseChannel
 *
 * @typedef {{
 *   channel: ResponseChannel,
 *   text: string
 * }} CommandResponse
 *
 * @typedef {{
 *   ok: boolean,
 *   handled: boolean,
 *   response?: CommandResponse,
 *   logCode?: string,
 *   retryable?: boolean
 * }} CommandHandlerResult
 */

/**
 * @param {Partial<CommandHandlerResult>} result
 * @param {Partial<CommandHandlerResult>} [defaults]
 * @returns {CommandHandlerResult}
 */
function normalizeHandlerResult (result, defaults = {}) {
  const merged = Object.assign(
    { ok: true, handled: true, retryable: false },
    defaults || {},
    result || {}
  )
  return /** @type {CommandHandlerResult} */ (merged)
}

/**
 * @param {string} text
 * @param {{ channel?: ResponseChannel, logCode?: string }} [opts]
 * @returns {CommandHandlerResult}
 */
function handledWithMessage (text, opts = {}) {
  return {
    ok: true,
    handled: true,
    response: { channel: opts.channel || DELIVERY_CHANNELS.CHAT, text: String(text || '') },
    logCode: opts.logCode || COMMAND_LOG_CODES.OK,
    retryable: false
  }
}

/** @returns {CommandHandlerResult} */
function handledNoMessage () {
  return { ok: true, handled: true, retryable: false }
}

/**
 * @param {string} logCode
 * @param {{ retryable?: boolean }} [opts]
 * @returns {CommandHandlerResult}
 */
function notHandled (logCode, opts = {}) {
  return {
    ok: false,
    handled: false,
    logCode: logCode || COMMAND_LOG_CODES.NOT_HANDLED,
    retryable: !!opts.retryable
  }
}

/**
 * Command rejected with a user-visible chat line (`ok: false`, `handled: true`).
 * @param {string} text
 * @param {{ channel?: ResponseChannel, logCode?: string, retryable?: boolean }} [opts]
 * @returns {CommandHandlerResult}
 */
function rejectWithMessage (text, opts = {}) {
  return {
    ok: false,
    handled: true,
    response: { channel: opts.channel || DELIVERY_CHANNELS.CHAT, text: String(text || '') },
    logCode: opts.logCode || COMMAND_LOG_CODES.NOT_HANDLED,
    retryable: !!opts.retryable
  }
}

module.exports = {
  normalizeHandlerResult,
  handledWithMessage,
  handledNoMessage,
  notHandled,
  rejectWithMessage
}
