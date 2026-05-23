'use strict'

/**
 * Simple sleep utility
 * @param {number} ms - milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { sleep }
