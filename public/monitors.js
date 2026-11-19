// Monitors: the words and colours for the Monitors page (a monitor's trigger, its next run, its runs).
'use strict'
;(function () {
  const WORDS = { running: 'Running', ok: 'OK', failed: 'Failed', 'needs-you': 'Needs you', skipped: 'Skipped' }
  /** The dot classes Workers already uses, so a status means the same colour on both pages. */
  const DOTS = { running: 'st-working', ok: 'st-done', failed: 'st-failed', 'needs-you': 'st-needs', skipped: 'st-idle' }

  function statusWord(status) { return WORDS[status] || status || 'Not run yet' }
  function dotClass(status) { return DOTS[status] || 'st-idle' }

  /** GET /monitors answers with a bare list; { monitors: [...] } like /workers works too. */
  function listFrom(r) { return Array.isArray(r) ? r : (r && r.monitors) || [] }

  /** The trigger in plain words as the hub wrote it ("Every 30 min", "Weekdays 07:30"), first letter up. */
  function triggerLine(trigger) {
    const text = (trigger && trigger.text) || ''
    if (text) return text[0].toUpperCase() + text.slice(1)
    return trigger && trigger.kind === 'check' ? 'On a check' : 'On a schedule'
  }

  const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  /** When it runs next, in words: "Paused", "Due now", "Next in 12 min", "Next at 9:00 PM", "Next tomorrow 7:30 AM". */
  function nextLabel(m, now = Date.now()) {
    if (!m.enabled) return 'Paused'
    if (!m.nextRunAt) return 'No next run'
    const at = new Date(m.nextRunAt)
    const mins = Math.round((at.getTime() - now) / 60000)
    if (mins < 1) return 'Due now'
    if (mins < 60) return `Next in ${mins} min`
    const today = new Date(now); today.setHours(0, 0, 0, 0)
    const day = new Date(at); day.setHours(0, 0, 0, 0)
    const days = Math.round((day - today) / 86400000)
    if (days === 0) return `Next at ${clock(at)}`
    if (days === 1) return `Next tomorrow ${clock(at)}`
    if (days < 7) return `Next ${at.toLocaleDateString([], { weekday: 'short' })} ${clock(at)}`
    return `Next ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
  }

  /** How long a run took ("48 s", "3 min", "1 h 5 min"); empty while it runs or if it never started. */
  function took(run) {
    if (!run || !run.startedAt || !run.endedAt) return ''
    const s = Math.max(0, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000))
    if (s < 60) return `${s} s`
    const m = Math.round(s / 60)
    if (m < 60) return `${m} min`
    return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
  }

  /** A run's one line: its summary, or its status when it has none ("Skipped: still running" comes as a summary). */
  function runLine(run) {
    if (!run) return 'Not run yet'
    const summary = (run.summary || '').trim()
    if (run.status === 'running') return summary || 'Running'
    const word = statusWord(run.status)
    if (!summary) return word
    // "Skipped: the last run was still going" already says it.
    return summary.toLowerCase().startsWith(word.toLowerCase()) ? summary : `${word} · ${summary}`
  }

  /** A monitor whose last run is still going can't be run again now (the hub says 409 too). */
  function isRunning(m) { return !!(m && m.lastRun && m.lastRun.status === 'running') }

  /** A creation time always shows its full date, e.g. "Nov 19, 2026, 5:23 PM" (never just a time). */
  function fullDate(t) {
    const d = new Date(t)
    if (isNaN(d.getTime())) return String(t)
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  /** The Details rows: who it runs as, where, and since when. Folder and date are shown with the page's own helpers. */
  function facts(m, folder, when) {
    return [
      ['Runs as', m.agent || 'No agent'],
      m.cwd ? ['Folder', folder ? folder(m.cwd) : m.cwd] : null,
      m.createdAt ? ['Created', fullDate(m.createdAt)] : null,
    ].filter(Boolean)
  }

  const api = { statusWord, dotClass, listFrom, triggerLine, nextLabel, took, runLine, isRunning, facts, fullDate }
  if (typeof window !== 'undefined') window.monitorView = api
  if (typeof module !== 'undefined') module.exports = api
})()
