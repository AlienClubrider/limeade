// The composer's draft around a send. On a computer Enter sends and Shift+Enter is a new line. The text
// sent leaves the box as it goes, so a second Enter can't send it again; a failed send puts it back.
'use strict'
;(function () {
  /** Whether a keydown in the box sends: plain Enter, on a computer (phones send with the arrow). */
  const sendsOnEnter = (e, computer) => computer && e.key === 'Enter' && !e.shiftKey

  /** The box after a send failed: the text sent back in front of anything typed while it was going. */
  function afterFailedSend(sent, typed) {
    return typed.trim() ? `${sent}\n${typed}` : sent
  }

  const api = { sendsOnEnter, afterFailedSend }
  if (typeof window !== 'undefined') window.composerDraft = api
  if (typeof module !== 'undefined') module.exports = api
})()
