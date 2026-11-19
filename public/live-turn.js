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
   * A running turn's text, split where its steps came: what it wrote before its latest step is narration
   * on the way ("Now move the other five lectures…"), never the reply. Each note sits before the step it
   * led into; `now` is the text since the latest step, which may yet be the reply. Steps from older hubs
   * have no `at`, so all the text stays `now`, as before.
   */
  function split(text, steps) {
    text = text || ''
    const notes = []
    let from = 0
    for (let i = 0; i < (steps || []).length; i++) {
      const at = steps[i].at
      if (typeof at !== 'number' || at < from) continue
      const note = untag(text.slice(from, Math.min(at, text.length)))
      if (note) notes.push({ before: i, text: note })
      from = Math.min(at, text.length)
    }
    return { notes, now: untag(text.slice(from)) }
  }

  /**
   * The assistant's "[quiet]" / "[needs you]" tags where a paragraph starts, as the hub drops them from a
   * finished reply (readQuiet, readNeeds, dropTags); the live text keeps them, since steps point into it
   * by position. Later updates in one turn may carry them too. Code blocks and tags inside a sentence stay.
   * A tag still arriving in pieces ("…\n\n[qui") shows as nothing until it is whole.
   */
  const TAG = /^([ \t]*)(\[(?:quiet|needs you)\][ \t]*)+/i
  const TAG_NAMES = ['[quiet]', '[needs you]']
  const untag = (s) => {
    const out = []
    let fenced = false
    let starts = true
    for (const line of s.split('\n')) {
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

  /** How long a step has run, said short ("45 s", "4 min", "1 h 5 min"); '' under half a minute. */
  function elapsed(ms) {
    const s = Math.floor(ms / 1000)
    if (!(s >= 30)) return ''
    if (s < 60) return `${s} s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m} min`
    return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
  }

  /**
   * An update said as one plain line, for the folded row while a turn runs: its markdown marks dropped
   * and its lines run together (the row cuts it to fit; unfolding shows it whole).
   */
  function oneLine(text) {
    return (text || '')
      .replace(/```[^\n]*\n?/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/(\*\*|__|`|~~)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * The row a turn's updates fold behind. While the turn runs it is the Assistant talking, so it shows as
   * a message (a card like its replies), saying the latest update on one line (cut to fit), or just the
   * count once unfolded, since the updates then show whole inside it. A finished reply's updates are
   * history above it: a plain "2 earlier updates" line.
   */
  function updatesRow(notes, live, open) {
    const n = (notes || []).length
    const count = `${n} ${live ? '' : 'earlier '}${n === 1 ? 'update' : 'updates'}`
    const gist = live && n && !open ? oneLine(notes[n - 1].text) : null
    return { message: !!live, gist, count: gist && n === 1 ? null : count, label: gist ? `${count}, latest: ${gist}` : count }
  }

  const api = { settle, addPiece, split, slot, elapsed, oneLine, updatesRow }
  if (typeof window !== 'undefined') window.liveTurn = api
  if (typeof module !== 'undefined') module.exports = api
})()
