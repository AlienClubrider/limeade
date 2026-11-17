// How wide the Chat page's list column is on a wide window, beside an open chat. The user drags its edge
// (or uses the arrow keys); the width he picks is kept on this device and fitted to the window.
'use strict'
;(function () {
  const DEFAULT = 400
  const MIN = 240
  const CHAT_MIN = 560 // the open chat never gets narrower than this
  const STEP = 16

  /** The widest the list may be: half the window, and never squeezing the chat under CHAT_MIN. */
  const maxFor = (windowWidth, side) => Math.max(MIN, Math.min(Math.floor(windowWidth / 2), windowWidth - side - CHAT_MIN))

  /** The width shown for a wanted width in a window this wide, with a sidebar (rail) this wide. */
  function fit(want, windowWidth, side) {
    const n = typeof want === 'number' && !Number.isNaN(want) ? Math.round(want) : DEFAULT
    return Math.min(maxFor(windowWidth, side), Math.max(MIN, n))
  }

  /** The kept width, or the default when none is kept (or it's junk). */
  function parse(stored) {
    const n = Number(stored)
    return stored != null && stored !== '' && Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT
  }

  /** The wanted width after a key on the handle, or null for a key it doesn't use. Shift moves further. */
  function afterKey(width, key, shift) {
    const step = shift ? STEP * 4 : STEP
    if (key === 'ArrowLeft') return width - step
    if (key === 'ArrowRight') return width + step
    if (key === 'Home') return MIN
    if (key === 'End') return Infinity
    return null
  }

  const api = { DEFAULT, MIN, fit, maxFor, parse, afterKey }
  if (typeof window !== 'undefined') window.listWidth = api
  if (typeof module !== 'undefined') module.exports = api
})()
