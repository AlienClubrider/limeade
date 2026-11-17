// A running turn's text and steps, shown at the bottom of a thread until its reply lands.
'use strict'
;(function () {
  /**
   * After a fresh read of the thread (or when it stops being busy): drop the live text and steps of turns
   * whose reply has landed, and all of them when nothing is running, so a missed event or a hub restart
   * never leaves a finished turn stuck at the bottom.
   */
  function settle(V) {
    const landed = new Set(V.chat.messages.map((m) => m.id))
    for (const live of [V.streaming, V.liveSteps]) {
      for (const id of Object.keys(live)) if (!V.chat.busy || landed.has(id)) delete live[id]
    }
    // The hub's copy of the running turn wins, unless we already have more of it (pieces that came after).
    const now = V.chat.busy && V.chat.live
    if (now && !landed.has(now.messageId)) {
      const mine = V.streaming[now.messageId] || ''
      if (!mine.startsWith(now.text)) V.streaming[now.messageId] = now.text
      if (!V.streaming[now.messageId]) delete V.streaming[now.messageId]
      if ((V.liveSteps[now.messageId] || []).length < now.steps.length) V.liveSteps[now.messageId] = now.steps
    }
  }

  /**
   * One streamed piece: `at` is where it goes in the reply so far, so a piece we already have (a page that
   * loaded the reply mid-way) lines up instead of doubling. Older hubs send no `at`: just append.
   */
  function addPiece(have, text, at) {
    have = have || ''
    return typeof at === 'number' && at <= have.length ? have.slice(0, at) + text : have + text
  }

  const api = { settle, addPiece }
  if (typeof window !== 'undefined') window.liveTurn = api
  if (typeof module !== 'undefined') module.exports = api
})()
