const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')

const SILERO_READY_TIMEOUT_MS = Number(process.env.VOICE_SILERO_READY_MS || 180000)
const SILERO_REQUEST_TIMEOUT_MS = Number(process.env.VOICE_SILERO_REQUEST_MS || 120000)

module.exports = function createVoice (config, utils, hooks = {}) {
  const { log } = utils
  const sendWavFile = typeof hooks.sendWavFile === 'function' ? hooks.sendWavFile : null

  let sileroProc = null
  let sileroReader = null
  let sileroStartPromise = null
  let speakChain = Promise.resolve()
  let speakQueueSize = 0

  function sanitizeForTts (input) {
    const raw = Buffer.from(String(input ?? ''), 'utf8').toString('utf8').normalize('NFC')
    const normalized = raw
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
      .replace(/[^0-9A-Za-zА-Яа-яЁё\s.,!?;:'"()\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!normalized) return ''
    if (!/[0-9A-Za-zА-Яа-яЁё]/.test(normalized)) return ''
    return normalized
  }

  function sleep (ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  function killSileroProc () {
    if (!sileroProc) return
    try {
      sileroReader?.rejectAll(new Error('silero server shutting down'))
    } catch (_) {}
    try {
      sileroProc.removeAllListeners()
    } catch (_) {}
    try {
      sileroProc.kill('SIGTERM')
    } catch (_) {}
    sileroProc = null
    sileroReader = null
  }

  function attachSileroStdoutReader (proc) {
    let buf = ''
    const pendingLines = []
    const waiters = []

    function deliverLine (line) {
      if (waiters.length) {
        const w = waiters.shift()
        if (w.timer) clearTimeout(w.timer)
        w.resolveLine(line)
      } else {
        pendingLines.push(line)
      }
    }

    function drainLines () {
      for (;;) {
        const n = buf.indexOf('\n')
        if (n < 0) return
        const line = buf.slice(0, n).replace(/\r$/, '')
        buf = buf.slice(n + 1)
        deliverLine(line)
      }
    }

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buf += chunk
      drainLines()
    })

    return {
      readLine (timeoutMs) {
        if (pendingLines.length) {
          return Promise.resolve(pendingLines.shift())
        }
        return new Promise((resolve, reject) => {
          const slot = {
            resolveLine (line) {
              if (slot.timer) clearTimeout(slot.timer)
              resolve(line)
            },
            rejectErr (e) {
              if (slot.timer) clearTimeout(slot.timer)
              reject(e)
            },
            timer: null
          }
          if (timeoutMs > 0) {
            slot.timer = setTimeout(() => {
              const idx = waiters.indexOf(slot)
              if (idx >= 0) waiters.splice(idx, 1)
              slot.rejectErr(new Error(`silero server line timeout (${timeoutMs} ms)`))
            }, timeoutMs)
          }
          waiters.push(slot)
        })
      },
      rejectAll (err) {
        while (waiters.length) {
          const w = waiters.shift()
          w.rejectErr(err)
        }
      }
    }
  }

  async function readJsonLine (reader, timeoutMs) {
    const line = await reader.readLine(timeoutMs)
    try {
      return JSON.parse(line)
    } catch (e) {
      throw new Error(`silero invalid JSON line: ${String(line).slice(0, 240)}`)
    }
  }

  async function waitForReady (reader) {
    const deadline = Date.now() + SILERO_READY_TIMEOUT_MS
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('silero server ready timeout')
      const msg = await readJsonLine(reader, left)
      if (msg.ready === true) return
      if (msg.ready === false) {
        throw new Error(msg.error || 'silero model load failed (ready:false)')
      }
    }
  }

  async function startSileroServer () {
    killSileroProc()

    const scriptPath = path.join(__dirname, 'silero_speak.py')
    const args = [
      scriptPath,
      '--server',
      '--voice', config.voiceSpeaker,
      '--model', config.voiceModel,
      '--sample-rate', String(config.voiceSampleRate),
      '--device-name', config.voiceOutputDevice,
      '--device-id', String(config.voiceDeviceId || '')
    ]

    const proc = spawn(config.voicePythonBin, args, {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    sileroProc = proc
    const reader = attachSileroStdoutReader(proc)
    sileroReader = reader

    proc.stderr.on('data', (d) => {
      process.stderr.write(d)
    })

    const onEarlyExit = new Promise((_, reject) => {
      proc.once('error', reject)
      proc.once('exit', (code, signal) => {
        reject(new Error(`silero server exited before ready (code=${code} signal=${signal ?? '—'})`))
      })
    })

    try {
      await Promise.race([waitForReady(reader), onEarlyExit])
    } catch (e) {
      killSileroProc()
      throw e
    }

    proc.removeAllListeners('exit')
    proc.removeAllListeners('error')
    proc.on('error', (err) => {
      log('[voice] silero server error:', err.message)
      reader.rejectAll(new Error('silero server process error'))
      killSileroProc()
    })
    proc.on('exit', (code, signal) => {
      log('[voice] silero server exit code=', code, 'signal=', signal == null ? '—' : String(signal))
      reader.rejectAll(new Error('silero server process exited'))
      sileroProc = null
      sileroReader = null
    })

    log('[voice] silero server ready (model loaded)')
  }

  async function ensureSileroServer () {
    if (sileroProc && sileroProc.exitCode == null && sileroReader) return
    await startSileroServer()
  }

  if (config.voiceEnabled) {
    sileroStartPromise = startSileroServer().catch((e) => {
      log('[voice] silero server failed to start at boot:', e.message)
    })
  }

  async function speak (text) {
    const message = sanitizeForTts(text)
    if (!message) return
    if (!config.voiceEnabled) return

    if (speakQueueSize >= 2) return
    speakQueueSize++

    try {
      speakChain = speakChain.catch(() => {}).then(async () => {
        try {
          await runSpeak(text)
        } finally {
          speakQueueSize--
        }
      })
      return await speakChain
    } catch (e) {
      log('[voice] speak error:', e.message)
      throw e
    }
  }

  async function runSpeak (text) {
    const message = sanitizeForTts(text)
    if (!message) return

    if (sileroStartPromise) await sileroStartPromise
    await ensureSileroServer()

    const useSvc = !!sendWavFile
    let outWav = null
    if (useSvc) {
      outWav = path.join(os.tmpdir(), `ai_bot_tts_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`)
    }

    const reader = sileroReader
    if (!reader || !sileroProc || sileroProc.exitCode != null) {
      throw new Error('silero server not available')
    }

    const req = JSON.stringify({
      text: message,
      wav: useSvc ? outWav : ''
    })

    try {
      const okWrite = sileroProc.stdin.write(req + '\n')
      if (!okWrite) {
        await new Promise((r, j) => {
          sileroProc.stdin.once('drain', r)
          sileroProc.stdin.once('error', j)
        })
      }
    } catch (e) {
      throw new Error(`silero stdin write failed: ${e.message}`)
    }

    const res = await readJsonLine(reader, SILERO_REQUEST_TIMEOUT_MS)

    if (res.ok === false) {
      const hint = res.error || JSON.stringify(res)
      throw new Error(`silero: ${hint}`)
    }

    if (res.skipped) {
      log('[voice] silero skipped (empty/invalid after clean on Python side)')
      return
    }

    if (useSvc && outWav) {
      try {
        if (!fs.existsSync(outWav)) {
          log('[voice] SVC: WAV not found after ok:', outWav)
          throw new Error(`expected wav missing: ${outWav}`)
        }
        await sendWavFile(outWav)
      } catch (e) {
        log('[voice] SVC sendWavFile:', e.message)
      } finally {
        if (!config.voiceKeepTempWav) {
          try {
            fs.unlinkSync(outWav)
          } catch (_) {}
        }
      }
    }
    await sleep(300)
  }

  function shutdownSilero () {
    killSileroProc()
    sileroStartPromise = null
  }

  return { speak, shutdownSilero }
}
