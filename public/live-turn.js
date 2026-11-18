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

  /**
   * The running reply as shown: without the assistant's "[quiet]" / "[needs you]" tags where a paragraph
   * starts, as the hub drops them from a finished reply (readQuiet, readNeeds, dropTags); the live text keeps
   * them, since streamed pieces point into it by position. Later updates in one turn may carry them too.
   * Code blocks and tags inside a sentence stay. A tag still arriving in pieces ("…\n\n[qui") shows as
   * nothing until it is whole.
   */
  const TAG = /^([ \t]*)(\[(?:quiet|needs you)\][ \t]*)+/i
  const TAG_NAMES = ['[quiet]', '[needs you]']
  function untag(text) {
    const out = []
    let fenced = false
    let starts = true
    for (const line of (text || '').split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      const bare = !fenced && starts ? line.replace(TAG, '$1') : line
      if (bare !== line && !bare.trim()) continue
      out.push(bare)
      starts = !line.trim()
    }
    const rest = out.join('\n').trim()
    if (fenced) return rest
    const para = rest.split(/\n[ \t]*\n/)
    const last = para[para.length - 1].trim().toLowerCase()
    if (last && TAG_NAMES.some((t) => t.startsWith(last))) return para.slice(0, -1).join('\n\n').trim()
    return rest
  }

  /**
   * Where the running turn shows in the thread: above his messages still waiting their turn (sent while
   * it ran), so what was already on screen keeps its order. The hub lands the reply in the same place.
   */
  function slot(messages, waiting) {
    const i = (messages || []).findIndex((m) => (waiting || []).includes(m.id))
    return i < 0 ? (messages || []).length : i
  }

  const api = { settle, addPiece, untag, slot }
  if (typeof window !== 'undefined') window.liveTurn = api
  if (typeof module !== 'undefined') module.exports = api
})()
