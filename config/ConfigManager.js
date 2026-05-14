'use strict'

const path = require('path')
const dotenv = require('dotenv')

let loaded = false

/**
 * Load `.env` once and validate secret-related invariants.
 * Call from `index.js` before any module reads `process.env` for AI/Minecraft secrets.
 */
function load (options = {}) {
  if (loaded) return
  const envPath = options.envPath != null ? String(options.envPath) : path.join(__dirname, '..', '.env')
  dotenv.config({ path: envPath })
  validate()
  loaded = true
}

function validate () {
  const openai = String(process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY || '').trim()
  const assistant = String(process.env.ASSISTANT_ID || process.env.OPENAI_ASSISTANT_ID || '').trim()
  const strict = process.env.STRICT_AI_ENV === '1' || process.env.RELEASE_STRICT === '1'

  if (assistant && !openai) {
    throw new Error(
      '[ConfigManager] ASSISTANT_ID (or OPENAI_ASSISTANT_ID) is set but OPENAI_API_KEY (or CHATGPT_API_KEY) is missing.'
    )
  }

  if (strict) {
    if (!openai) {
      throw new Error('[ConfigManager] STRICT_AI_ENV / RELEASE_STRICT: OPENAI_API_KEY (or CHATGPT_API_KEY) is required.')
    }
    if (!assistant) {
      throw new Error('[ConfigManager] STRICT_AI_ENV / RELEASE_STRICT: ASSISTANT_ID (or OPENAI_ASSISTANT_ID) is required.')
    }
  }
}

function assertLoaded () {
  if (!loaded) {
    throw new Error('[ConfigManager] load() was not called before reading secured config. Import index entry or call ConfigManager.load() first.')
  }
}

module.exports = {
  load,
  validate,
  assertLoaded,
  get loaded () {
    return loaded
  }
}
