/**
 * Simple Voice Chat: перехват TCP `voicechat:secret` + UDP-рукопожатие (AES-GCM), как в моде.
 * Не трогает pathfinder / movement — только bot._client + dgram.
 *
 * Протокол UDP (клиент → сервер): см. ClientNetworkMessage.writeClient в simple-voice-chat.
 */
'use strict'

const fs = require('fs')
const dgram = require('dgram')
const crypto = require('crypto')
const mcTypes = require('minecraft-protocol/src/datatypes/minecraft.js')
const [readVarInt, writeVarInt] = require('protodef').types.varint
const [readUUID] = mcTypes.UUID
const [, writeUUID] = mcTypes.UUID

const MAGIC = 0xff

const PACKET = {
  MIC: 0x01,
  PLAYER_SOUND: 0x02,
  GROUP_SOUND: 0x03,
  LOCATION_SOUND: 0x04,
  AUTHENTICATE: 0x05,
  AUTHENTICATE_ACK: 0x06,
  PING: 0x07,
  KEEPALIVE: 0x08,
  CONNECTION_CHECK: 0x09,
  CONNECTION_CHECK_ACK: 0x0a
}

function readMcUtf (buf, offset, maxLen) {
  const lenR = readVarInt(buf, offset)
  const len = lenR.value
  if (len < 0 || len > maxLen) throw new Error(`invalid UTF string length ${len}`)
  const start = offset + lenR.size
  const value = buf.toString('utf8', start, start + len)
  return { value, size: lenR.size + len }
}

function parseSecretTcpPayload (buf) {
  let o = 0
  const secretKey = buf.subarray(o, o + 16)
  o += 16
  const serverPort = buf.readInt32BE(o)
  o += 4
  const uuidR = readUUID(buf, o)
  o += uuidR.size
  const playerUuidStr = uuidR.value
  /* codec */ buf.readUInt8(o)
  o += 1
  /* mtu */ buf.readInt32BE(o)
  o += 4
  /* distance */ buf.readDoubleBE(o)
  o += 8
  const keepAlive = buf.readInt32BE(o)
  o += 4
  /* groups */ buf.readUInt8(o)
  o += 1
  const hostR = readMcUtf(buf, o, 32767)
  o += hostR.size
  /* allowRecording */ buf.readUInt8(o)
  o += 1
  return {
    secretKey,
    serverPort,
    playerUuidStr,
    voiceHost: hostR.value,
    keepAliveMs: keepAlive
  }
}

function encryptAesGcm (secretKey, plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-128-gcm', secretKey, iv, { authTagLength: 16 })
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ct, tag])
}

function decryptAesGcm (secretKey, payload) {
  if (payload.length < 12 + 16 + 1) throw new Error('encrypted payload too short')
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(payload.length - 16)
  const ct = payload.subarray(12, payload.length - 16)
  const decipher = crypto.createDecipheriv('aes-128-gcm', secretKey, iv, { authTagLength: 16 })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

function buildClientUdpPacket (playerUuidStr, secretKey, innerPlain) {
  const enc = encryptAesGcm(secretKey, innerPlain)
  const uuidBuf = Buffer.allocUnsafe(16)
  writeUUID(playerUuidStr, uuidBuf, 0)
  const vi = Buffer.allocUnsafe(5)
  const viEnd = writeVarInt(enc.length, vi, 0)
  return Buffer.concat([Buffer.from([MAGIC]), uuidBuf, vi.subarray(0, viEnd), enc])
}

function buildAuthenticateInner (playerUuidStr, secretKey) {
  const inner = Buffer.allocUnsafe(33)
  inner.writeUInt8(PACKET.AUTHENTICATE, 0)
  writeUUID(playerUuidStr, inner, 1)
  secretKey.copy(inner, 17)
  return inner
}

function parseIncomingServerUdp (msg, secretKey) {
  if (msg.length < 2 || msg.readUInt8(0) !== MAGIC) return null
  let o = 1
  const lenR = readVarInt(msg, o)
  o += lenR.size
  const enc = msg.subarray(o, o + lenR.value)
  if (enc.length !== lenR.value) return null
  const plain = decryptAesGcm(secretKey, enc)
  const type = plain.readUInt8(0)
  return { type, plain }
}

/** Minecraft-style byte array: VarInt length + raw bytes (MicPacket data field). */
function writeMcByteArray (bytes) {
  const vi = Buffer.allocUnsafe(5)
  const n = writeVarInt(bytes.length, vi, 0)
  return Buffer.concat([vi.subarray(0, n), bytes])
}

/**
 * MicPacket.toBytes: opus payload, sequence (int64), whispering (bool).
 * @see https://github.com/henkelmax/simple-voice-chat/blob/1.21.1/common/src/main/java/de/maxhenkel/voicechat/voice/common/MicPacket.java
 */
function buildMicPacketInner (opusBytes, sequenceBigInt, whispering) {
  const tail = Buffer.allocUnsafe(9)
  tail.writeBigInt64BE(sequenceBigInt, 0)
  tail.writeUInt8(whispering ? 1 : 0, 8)
  return Buffer.concat([
    Buffer.from([PACKET.MIC]),
    writeMcByteArray(Buffer.from(opusBytes)),
    tail
  ])
}

function readWavMonoInt16 (wavPath) {
  const buf = fs.readFileSync(wavPath)
  if (buf.length < 44) throw new Error('wav too small')
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a PCM RIFF WAV')
  }
  let o = 12
  let fmt = null
  let dataChunk = null
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4)
    const chunkSize = buf.readUInt32LE(o + 4)
    o += 8
    if (id === 'fmt ') {
      fmt = buf.subarray(o, o + chunkSize)
    } else if (id === 'data') {
      dataChunk = buf.subarray(o, o + chunkSize)
      break
    }
    o += chunkSize + (chunkSize % 2)
  }
  if (!fmt || !dataChunk) throw new Error('wav missing fmt or data chunk')
  if (fmt.length < 16) throw new Error(`wav fmt chunk too short (${fmt.length}), need PCM fmt`)
  const audioFormat = fmt.readUInt16LE(0)
  const numChannels = fmt.readUInt16LE(2)
  const sampleRate = fmt.readUInt32LE(4)
  const bitsPerSample = fmt.readUInt16LE(14)
  if (audioFormat !== 1) throw new Error(`wav unsupported audio format ${audioFormat} (need PCM=1)`)
  if (bitsPerSample !== 16) throw new Error(`wav need 16-bit PCM, got ${bitsPerSample}`)
  const bytesPerSample = bitsPerSample / 8
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1) {
    throw new Error(`wav invalid bytesPerSample from bitsPerSample=${bitsPerSample}`)
  }
  const frameBytes = numChannels * bytesPerSample
  if (frameBytes < 2 || dataChunk.length < frameBytes) throw new Error('wav data too small for frame size')
  const alignedBytes = Math.floor(dataChunk.length / frameBytes) * frameBytes
  const pcmData = alignedBytes === dataChunk.length ? dataChunk : dataChunk.subarray(0, alignedBytes)
  const numFrames = Math.floor(pcmData.length / frameBytes)
  const mono = new Int16Array(numFrames)
  if (numChannels === 1) {
    for (let i = 0; i < numFrames; i++) mono[i] = pcmData.readInt16LE(i * bytesPerSample)
  } else {
    for (let i = 0; i < numFrames; i++) {
      let sum = 0
      for (let c = 0; c < numChannels; c++) {
        sum += pcmData.readInt16LE(i * frameBytes + c * bytesPerSample)
      }
      mono[i] = Math.round(sum / numChannels)
    }
  }
  return { samples: mono, sampleRate, numChannels, bitsPerSample }
}

function resampleLinearToRate (input, fromRate, toRate) {
  const fr = Number(fromRate)
  const tr = Number(toRate)
  if (!Number.isFinite(fr) || fr <= 0) throw new Error(`resample: invalid fromRate=${fromRate}`)
  if (!Number.isFinite(tr) || tr <= 0) throw new Error(`resample: invalid toRate=${toRate}`)
  if (fr === tr) return input
  const ratio = toRate / fromRate
  const outLen = Math.max(1, Math.floor(input.length * ratio))
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcPos = (i + 0.5) / ratio - 0.5
    const i0 = Math.max(0, Math.min(input.length - 1, Math.floor(srcPos)))
    const i1 = Math.min(input.length - 1, i0 + 1)
    const f = srcPos - i0
    out[i] = Math.round(input[i0] * (1 - f) + input[i1] * f)
  }
  return out
}

const OPUS_RATE = 48000
const OPUS_FRAME_SAMPLES = 960
/**
 * Пауза между UDP-отправками по умолчанию (мс): чуть меньше 20 ms кадра Opus — компенсирует задержку отправки.
 */
const OPUS_UDP_DEFAULT_SPACING_MS = 18

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** MC / voice bind: localhost, ::1, 127.x.x.x */
function hostLooksLocal (h) {
  const s = String(h ?? '').trim().toLowerCase()
  if (!s) return false
  if (s === 'localhost' || s === '::1') return true
  if (s === '0.0.0.0') return true
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1])
  return a === 127
}

/** Непустой host из секрета, который явно не loopback (внешний DNS/IP). */
function voiceSecretHostLooksExternal (h) {
  const s = String(h ?? '').trim()
  if (!s) return false
  return !hostLooksLocal(s)
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{
 *   log: Function,
 *   tcpHost: string,
 *   compatibilityVersion?: number,
 *   debugAllChannels?: boolean,
 *   voiceUdpReadyTimeoutMs?: number,
 *   voiceOpusFrameSpacingMs?: number,
 *   voiceTailSilenceFrames?: number,
 *   voiceUdpPreambleFrames?: number,
 *   voicePostAudioGapMs?: number,
 *   forceLocalUdpHost?: boolean,
 *   voiceUdpAutoLoopbackExternal?: boolean
 * }} opts
 */
const LOCAL_UDP_HOST_OVERRIDE = '127.0.0.1'

module.exports = function attachSimpleVoiceChatUdp (bot, opts) {
  const log = opts.log || console.log
  const tcpHost = opts.tcpHost || 'localhost'
  const compat = Number(opts.compatibilityVersion ?? 20)
  const debugAll = !!opts.debugAllChannels
  const forceLocalUdpHost = !!opts.forceLocalUdpHost
  const voiceUdpAutoLoopbackExternal = opts.voiceUdpAutoLoopbackExternal !== false

  log(
    '[VoiceChat] attach opts:',
    'forceLocalUdpHost=', forceLocalUdpHost,
    'voiceUdpAutoLoopbackExternal=', voiceUdpAutoLoopbackExternal,
    'tcpHost(MC_HOST)=', tcpHost
  )
  const voiceReadyMs = Number(opts.voiceUdpReadyTimeoutMs ?? 20000)
  const rawSpacing = Number(opts.voiceOpusFrameSpacingMs)
  const frameSpacingMs =
    Number.isFinite(rawSpacing) && rawSpacing >= 5
      ? Math.min(rawSpacing, 120)
      : OPUS_UDP_DEFAULT_SPACING_MS
  const rawTail = Number(opts.voiceTailSilenceFrames)
  const silenceTailFrames = Number.isFinite(rawTail)
    ? Math.min(16, Math.max(0, Math.floor(rawTail)))
    : 8
  const rawPreamble = Number(opts.voiceUdpPreambleFrames)
  const preambleFrames = Number.isFinite(rawPreamble)
    ? Math.min(16, Math.max(0, Math.floor(rawPreamble)))
    : 4
  const rawGap = Number(opts.voicePostAudioGapMs)
  const postAudioGapMs =
    Number.isFinite(rawGap) && rawGap >= 0 ? Math.min(2000, rawGap) : 200

  let udpSocket = null
  let voiceSecret = null
  let voicePort = 24454
  let voiceHost = tcpHost
  let playerUuidStr = null
  let authTimer = null
  let keepAliveTimer = null
  let authenticated = false
  let connected = false
  let micSeq = 0n

  async function waitUdpConnected (maxMs) {
    const limit = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : voiceReadyMs
    const t0 = Date.now()
    while (Date.now() - t0 < limit) {
      if (connected && udpSocket && voiceSecret && playerUuidStr) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`VoiceChat UDP not ready within ${limit}ms`)
  }

  /**
   * Прочитать WAV (16-bit PCM), закодировать Opus (48 kHz mono, 20 ms кадры) и отправить MicPacket по UDP.
   * @param {string} wavPath
   */
  async function sendWavFile (wavPath) {
    const maxAttempts = 5
    let udpOk = false
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const phaseMs = attempt < maxAttempts ? Math.min(voiceReadyMs, 10000) : voiceReadyMs
      try {
        await waitUdpConnected(phaseMs)
        udpOk = true
        break
      } catch (e) {
        log('[VoiceChat] sendWavFile: UDP wait attempt', attempt, '/', maxAttempts, e.message)
        if (attempt >= maxAttempts) {
          log('[VoiceChat] sendWavFile skipped:', e.message)
          return
        }
        await new Promise((r) => setTimeout(r, 250 * attempt))
      }
    }
    if (!udpOk) return
    let OpusScript
    try {
      OpusScript = require('opusscript')
    } catch (e) {
      log('[VoiceChat] sendWavFile: opusscript not installed:', e.message)
      return
    }
    let pcm48
    try {
      const { samples, sampleRate, numChannels, bitsPerSample } = readWavMonoInt16(wavPath)
      log(
        '[VoiceChat] sendWavFile wav:',
        sampleRate,
        'Hz',
        numChannels,
        'ch',
        bitsPerSample,
        'bit,',
        samples.length,
        'mono samples'
      )
      if (sampleRate !== OPUS_RATE) {
        log('[VoiceChat] sendWavFile resampling linear', sampleRate, '->', OPUS_RATE, '(use 48 kHz WAV to avoid)')
      }
      pcm48 = resampleLinearToRate(samples, sampleRate, OPUS_RATE)
    } catch (e) {
      log('[VoiceChat] sendWavFile wav read:', e.message)
      return
    }
    let enc
    try {
      enc = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP, { wasm: true })
    } catch (e) {
      try {
        enc = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP, { wasm: false })
      } catch (e2) {
        log('[VoiceChat] Opus encoder init failed:', e2.message)
        return
      }
    }
    const frameBuf = Buffer.alloc(OPUS_FRAME_SAMPLES * 2)
    try {
      const preamblePackets = []
      const audioPackets = []
      const silencePackets = []
      let maxEncodeMs = 0
      let slowEncodeCount = 0
      const preEncodeWallStart = Date.now()

      function noteEncodeMs (encMs, label, index) {
        if (encMs > maxEncodeMs) maxEncodeMs = encMs
        if (encMs > frameSpacingMs) {
          slowEncodeCount += 1
          log(
            '[VoiceChat] sendWavFile encode',
            encMs,
            'ms > spacing',
            frameSpacingMs,
            'ms',
            label,
            'idx',
            index
          )
        }
      }

      frameBuf.fill(0)
      for (let p = 0; p < preambleFrames; p++) {
        const tEnc = Date.now()
        const opusSilence = enc.encode(frameBuf, OPUS_FRAME_SAMPLES)
        noteEncodeMs(Date.now() - tEnc, 'preamble', p)
        preamblePackets.push(Buffer.from(opusSilence))
      }

      for (let i = 0; i < pcm48.length; i += OPUS_FRAME_SAMPLES) {
        const tEnc = Date.now()
        frameBuf.fill(0)
        const n = Math.min(OPUS_FRAME_SAMPLES, pcm48.length - i)
        for (let j = 0; j < n; j++) frameBuf.writeInt16LE(pcm48[i + j], j * 2)
        const opusPacket = enc.encode(frameBuf, OPUS_FRAME_SAMPLES)
        noteEncodeMs(Date.now() - tEnc, 'audio', audioPackets.length)
        audioPackets.push(Buffer.from(opusPacket))
      }
      frameBuf.fill(0)
      for (let t = 0; t < silenceTailFrames; t++) {
        const tEnc = Date.now()
        const opusSilence = enc.encode(frameBuf, OPUS_FRAME_SAMPLES)
        noteEncodeMs(Date.now() - tEnc, 'silence', t)
        silencePackets.push(Buffer.from(opusSilence))
      }

      const preEncodeWallMs = Date.now() - preEncodeWallStart
      if (slowEncodeCount > 0) {
        log(
          '[VoiceChat] sendWavFile pre-encode summary: slow',
          slowEncodeCount,
          '/',
          preamblePackets.length + audioPackets.length + silencePackets.length,
          'maxEncodeMs=',
          maxEncodeMs
        )
      }
      log(
        '[VoiceChat] sendWavFile pre-encode wall',
        preEncodeWallMs,
        'ms packets',
        preamblePackets.length + audioPackets.length + silencePackets.length,
        '(send uses slot timing only)'
      )

      /** Отправка: encode уже не влияет на дедлайны слотов. */
      const streamStart = Date.now()
      let slotIndex = 0
      async function waitForNextFrameSlot () {
        const deadline = streamStart + slotIndex * frameSpacingMs
        slotIndex += 1
        const waitMs = Math.max(0, deadline - Date.now())
        if (waitMs > 0) await sleep(waitMs)
      }

      for (let p = 0; p < preamblePackets.length; p++) {
        await waitForNextFrameSlot()
        micSeq += 1n
        sendUdpInner(buildMicPacketInner(preamblePackets[p], micSeq, false))
      }
      for (let a = 0; a < audioPackets.length; a++) {
        await waitForNextFrameSlot()
        micSeq += 1n
        sendUdpInner(buildMicPacketInner(audioPackets[a], micSeq, false))
      }
      if (postAudioGapMs > 0) await sleep(postAudioGapMs)
      const tailStart = Date.now()
      let tailSlot = 0
      async function waitTailSlot () {
        const deadline = tailStart + tailSlot * frameSpacingMs
        tailSlot += 1
        const w = Math.max(0, deadline - Date.now())
        if (w > 0) await sleep(w)
      }
      for (let s = 0; s < silencePackets.length; s++) {
        await waitTailSlot()
        micSeq += 1n
        sendUdpInner(buildMicPacketInner(silencePackets[s], micSeq, false))
      }
      log(
        '[VoiceChat] sendWavFile done',
        preamblePackets.length,
        'preamble +',
        audioPackets.length,
        'audio +',
        silencePackets.length,
        'tail silence gapMs=',
        postAudioGapMs,
        'spacingMs=',
        frameSpacingMs
      )
    } catch (e) {
      log('[VoiceChat] sendWavFile encode/send:', e.message)
    } finally {
      try {
        enc.delete()
      } catch (_) {}
    }
  }

  /** Закрыть сокет и таймеры; секрет/host/port не трогаем (нужно при повторном initUdp). */
  function shutdownUdpTransport () {
    if (authTimer) {
      clearInterval(authTimer)
      authTimer = null
    }
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }
    if (udpSocket) {
      try {
        udpSocket.close()
      } catch (_) {}
      udpSocket = null
    }
    authenticated = false
    connected = false
  }

  function teardownVoiceUdp () {
    shutdownUdpTransport()
    voiceSecret = null
    playerUuidStr = null
  }

  function sendUdpInner (innerPlain) {
    if (!udpSocket || !voiceSecret || !playerUuidStr) return
    const pkt = buildClientUdpPacket(playerUuidStr, voiceSecret, innerPlain)
    udpSocket.send(pkt, voicePort, voiceHost, (err) => {
      if (err) log('[VoiceChat UDP] send error:', err.message)
    })
  }

  function sendAuth () {
    sendUdpInner(buildAuthenticateInner(playerUuidStr, voiceSecret))
  }

  function sendConnectionCheck () {
    sendUdpInner(Buffer.from([PACKET.CONNECTION_CHECK]))
  }

  function sendKeepAliveResponse () {
    sendUdpInner(Buffer.from([PACKET.KEEPALIVE]))
  }

  function startAuthLoop () {
    if (authTimer) clearInterval(authTimer)
    authTimer = setInterval(() => {
      if (!udpSocket || !voiceSecret) return
      if (!authenticated) {
        log('[VoiceChat] trying authenticate (UDP)')
        sendAuth()
      } else if (!connected) {
        log('[VoiceChat] trying connection check (UDP)')
        sendConnectionCheck()
      } else {
        clearInterval(authTimer)
        authTimer = null
      }
    }, 1000)
  }

  function initUdp () {
    shutdownUdpTransport()
    udpSocket = dgram.createSocket('udp4')
    udpSocket.on('error', (err) => {
      log('[VoiceChat UDP] socket error:', err.message)
    })
    udpSocket.on('message', (msg) => {
      try {
        const parsed = parseIncomingServerUdp(msg, voiceSecret)
        if (!parsed) return
        const t = parsed.type
        const names = {
          [PACKET.AUTHENTICATE]: 'AUTH',
          [PACKET.AUTHENTICATE_ACK]: 'AUTH_ACK',
          [PACKET.KEEPALIVE]: 'KEEPALIVE',
          [PACKET.PING]: 'PING',
          [PACKET.CONNECTION_CHECK]: 'CONN_CHECK',
          [PACKET.CONNECTION_CHECK_ACK]: 'CONN_CHECK_ACK',
          [PACKET.PLAYER_SOUND]: 'PLAYER_SOUND',
          [PACKET.MIC]: 'MIC'
        }
        if (t !== PACKET.KEEPALIVE) {
          log('[VoiceChat UDP] incoming type:', names[t] || `unknown(${t})`)
        }

        if (t === PACKET.AUTHENTICATE_ACK) {
          authenticated = true
          log('[VoiceChat UDP] AuthenticateAck — сервер подтвердил auth')
        } else if (t === PACKET.CONNECTION_CHECK_ACK) {
          connected = true
          log('[VoiceChat UDP] ConnectionCheckAck — сессия установлена')
        } else if (t === PACKET.KEEPALIVE) {
          sendKeepAliveResponse()
        } else if (t === PACKET.PING) {
          sendUdpInner(parsed.plain)
        }
      } catch (e) {
        log('[VoiceChat UDP] parse/decrypt error:', e.message)
      }
    })

    udpSocket.bind(0, () => {
      const a = udpSocket.address()
      log('[VoiceChat UDP] bound local port', a && a.port)
      sendAuth()
      startAuthLoop()
    })
  }

  function onSecretPacket (data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
    let parsed
    try {
      parsed = parseSecretTcpPayload(buf)
    } catch (e) {
      log('[VoiceChat] failed to parse voicechat:secret:', e.message)
      return
    }
    voiceSecret = parsed.secretKey
    voicePort = parsed.serverPort
    playerUuidStr = parsed.playerUuidStr
    micSeq = 0n
    const secretHost = (parsed.voiceHost || '').trim()
    const useLoopbackFromEnv = forceLocalUdpHost
    const useLoopbackAuto =
      voiceUdpAutoLoopbackExternal &&
      !useLoopbackFromEnv &&
      hostLooksLocal(tcpHost) &&
      voiceSecretHostLooksExternal(secretHost)

    if (useLoopbackFromEnv || useLoopbackAuto) {
      voiceHost = LOCAL_UDP_HOST_OVERRIDE
      log(
        '[VoiceChat] UDP host ->',
        voiceHost,
        useLoopbackFromEnv
          ? '(VOICE_FORCE_LOCAL_UDP)'
          : '(auto: MC_HOST local, secret host external)',
        'secret_host=',
        JSON.stringify(secretHost || null),
        'tcpHost=',
        JSON.stringify(tcpHost)
      )
    } else {
      voiceHost = secretHost || tcpHost
    }
    log(`[VoiceChat] Secret received. UDP ${voiceHost}:${voicePort}, keepAlive=${parsed.keepAliveMs}ms`)

    initUdp()

    const ka = Math.min(Math.max(Number(parsed.keepAliveMs) || 1000, 400), 4000)
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    keepAliveTimer = setInterval(() => {
      if (connected && udpSocket) sendKeepAliveResponse()
    }, ka)
  }

  bot._client.on('custom_payload', (packet) => {
    const ch = packet.channel
    if (debugAll) log('[VoiceChat] channel:', ch)
    if (ch === 'voicechat:secret') {
      const len = packet.data?.length
      log('[VoiceChat] Got secret packet! Data length:', len)
      onSecretPacket(packet.data)
    }
  })

  bot.once('spawn', () => {
    try {
      const req = Buffer.allocUnsafe(4)
      req.writeInt32BE(compat, 0)
      bot._client.write('custom_payload', {
        channel: 'voicechat:request_secret',
        data: req
      })
      log('[VoiceChat] sent voicechat:request_secret compat=', compat)
    } catch (e) {
      log('[VoiceChat] request_secret send failed:', e.message)
    }
  })

  bot.on('end', () => {
    log('[VoiceChat] TCP end — closing UDP')
    teardownVoiceUdp()
  })

  return { sendWavFile }
}
