// Keeps a chat thread at its end while the user is there.
'use strict'
;(function () {
  /**
   * Only his own scrolling (a finger, the wheel, the scrollbar, scroll keys) lets go of the end. The thread
   * moving under him (a photo loading, the keyboard opening, the composer growing, a repaint) never does,
   * and puts him back at the end if he was there.
   */
  function follow(box, { near = 60, now = () => Date.now(), win = typeof window !== 'undefined' ? window : null } = {}) {
    let stuck = true
    let holding = false // finger or mouse button down on the thread
    let movedAt = -Infinity // his last scroll gesture; a flick keeps scrolling a moment after the finger lifts
    const atEnd = () => box.scrollHeight - box.scrollTop - box.clientHeight < near
    const his = () => holding || now() - movedAt < 800
    const toEnd = () => { box.scrollTop = box.scrollHeight }
    const moved = () => { movedAt = now() }
    const on = (t, ev, fn) => t?.addEventListener(ev, fn, { passive: true })

    on(box, 'touchstart', () => { holding = true; moved() })
    on(box, 'pointerdown', () => { holding = true; moved() })
    for (const ev of ['touchend', 'touchcancel', 'pointerup', 'pointercancel']) on(win, ev, () => { if (holding) { holding = false; moved() } })
    on(box, 'wheel', moved)
    on(box, 'touchmove', moved)
    // Scroll keys, but not typing in the composer.
    on(win, 'keydown', (e) => { if (!e.target?.closest?.('textarea, input, [contenteditable]')) moved() })

    on(box, 'scroll', () => {
      if (atEnd()) stuck = true
      else if (his()) stuck = false
      else if (stuck) toEnd()
    })
    // The thread's own size (keyboard, composer) and photos finishing loading.
    const pin = () => { if (stuck) toEnd() }
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(pin).observe(box)
    box.addEventListener('load', pin, true)

    return {
      /** True while he's at the end (or hasn't scrolled away from it himself). */
      get stuck() { return stuck },
      /** Go to the end and stay there. */
      toEnd() { stuck = true; toEnd() },
      /** Back to the end if that's where he was. */
      keep: pin,
    }
  }

  const api = { follow }
  if (typeof window !== 'undefined') window.threadEnd = api
  if (typeof module !== 'undefined') module.exports = api
})()
