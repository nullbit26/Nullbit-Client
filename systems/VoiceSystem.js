'use strict'

const attachSimpleVoiceChatUdp = require('../features/simple-voice-chat-udp')
const createVoice = require('../voice')
const { VoiceEvents } = require('../core/EventRegistry')

/**
 * Silero TTS + optional Simple Voice Chat UDP, driven by {@link ../core/EventBus} (`voice:speak`, `voice:stop`).
 * UDP / Opus / WAV encoding paths are delegated unchanged to `features/simple-voice-chat-udp.js` and `voice/index.js`.
 *
 * @typedef {Object} VoiceSystemOptions
 * @property {import('mineflayer').Bot} bot
 * @property {import('../core/EventBus').EventBus} eventBus
 * @property {import('../config')} config
 * @property {{ log: Function }} utils
 */

class VoiceSystem {
  /**
   * @param {VoiceSystemOptions} opts
   */
  constructor (opts) {
    if (!opts?.bot) throw new Error('[VoiceSystem] bot is required')
    if (!opts?.eventBus) throw new Error('[VoiceSystem] eventBus is required')
    if (!opts?.config) throw new Error('[VoiceSystem] config is required')
    if (!opts?.utils?.log) throw new Error('[VoiceSystem] utils.log is required')

    /** @private @readonly */
    this._bot = opts.bot
    /** @private @readonly */
    this._bus = opts.eventBus
    /** @private @readonly */
    this._config = opts.config
    /** @private @readonly */
    this._log = opts.utils.log

    /** @private */
    this._voiceHooks = {}
    if (this._config.voiceChatUdpEnabled) {
      this._log(
        '[VoiceChat] startup config:',
        'voiceForceLocalUdpHost=',
        this._config.voiceForceLocalUdpHost,
        'raw VOICE_FORCE_LOCAL_UDP=',
        JSON.stringify(process.env.VOICE_FORCE_LOCAL_UDP ?? null),
        'voiceUdpAutoLoopbackExternal=',
        this._config.voiceUdpAutoLoopbackExternal,
        'MC_HOST=',
        this._config.host
      )
      const svc = attachSimpleVoiceChatUdp(this._bot, {
        log: this._log,
        tcpHost: this._config.host,
        compatibilityVersion: this._config.voiceChatCompatibilityVersion,
        debugAllChannels: this._config.voiceChatDebugPayloads,
        voiceUdpReadyTimeoutMs: this._config.voiceUdpReadyTimeoutMs,
        voiceOpusFrameSpacingMs: this._config.voiceOpusFrameSpacingMs,
        voiceTailSilenceFrames: this._config.voiceTailSilenceFrames,
        voiceUdpPreambleFrames: this._config.voiceUdpPreambleFrames,
        voicePostAudioGapMs: this._config.voicePostAudioGapMs,
        forceLocalUdpHost: this._config.voiceForceLocalUdpHost,
        voiceUdpAutoLoopbackExternal: this._config.voiceUdpAutoLoopbackExternal
      })
      if (typeof svc.sendWavFile === 'function') {
        this._voiceHooks.sendWavFile = svc.sendWavFile
      }
    }

    /** @private @readonly — same implementation as legacy `createVoice` */
    this._impl = createVoice(this._config, opts.utils, this._voiceHooks)

    /** @private */
    this._onSpeak = this._onSpeak.bind(this)
    /** @private */
    this._onStop = this._onStop.bind(this)
    /** @private */
    this._wired = false
  }

  /** @private */
  _onSpeak (payload) {
    const text = payload && typeof payload.text === 'string' ? payload.text : ''
    if (!text) return
    void this._impl.speak(text).catch((e) => this._log('[voice] speak (bus):', e.message))
  }

  /** @private */
  _onStop (payload) {
    const hard = payload == null || payload.shutdownSilero !== false
    if (hard) {
      try {
        this._impl.shutdownSilero()
      } catch (e) {
        this._log('[voice] stop:', e.message)
      }
    }
  }

  /**
   * Same public shape as legacy `createVoice` return value.
   * @returns {{ speak: (text: string) => Promise<unknown>, shutdownSilero: () => void }}
   */
  getVoiceHandle () {
    return {
      speak: (text) => this._impl.speak(text),
      shutdownSilero: () => {
        try {
          this._impl.shutdownSilero()
        } catch (_) {}
      }
    }
  }

  init () {
    if (this._wired) return
    this._wired = true
    this._bus.on(VoiceEvents.SPEAK, this._onSpeak)
    this._bus.on(VoiceEvents.STOP, this._onStop)
  }

  destroy () {
    if (!this._wired) return
    this._wired = false
    this._bus.off(VoiceEvents.SPEAK, this._onSpeak)
    this._bus.off(VoiceEvents.STOP, this._onStop)
    try {
      this._impl.shutdownSilero()
    } catch (_) {}
  }
}

module.exports = { VoiceSystem }
