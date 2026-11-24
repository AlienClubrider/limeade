import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isWebFile } from '../src/adapters/web-files.ts'
const mv = createRequire(import.meta.url)('../public/monitors.js')

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
const NOW = new Date(2026, 10, 19, 14, 0).getTime() // Thu 19 Nov 2026, 2:00 PM local
const at = (mins: number) => new Date(NOW + mins * 60000).toISOString()

test('monitors page: the next run in words', () => {
  assert.equal(mv.nextLabel({ enabled: false, nextRunAt: at(5) }, NOW), 'Paused')
  assert.equal(mv.nextLabel({ enabled: true, nextRunAt: null }, NOW), 'No next run')
  assert.equal(mv.nextLabel({ enabled: true, nextRunAt: at(-3) }, NOW), 'Due now')
  assert.equal(mv.nextLabel({ enabled: true, nextRunAt: at(12) }, NOW), 'Next in 12 min')
  assert.match(mv.nextLabel({ enabled: true, nextRunAt: at(7 * 60) }, NOW), /^Next at 9:00/)
  assert.match(mv.nextLabel({ enabled: true, nextRunAt: at(17 * 60 + 30) }, NOW), /^Next tomorrow 7:30/)
  assert.match(mv.nextLabel({ enabled: true, nextRunAt: at(4 * 1440) }, NOW), /^Next Mon /)
})

test('monitors page: a trigger and a run in plain words, with the colours Workers uses', () => {
  assert.equal(mv.triggerLine({ kind: 'schedule', text: 'every 30 min', spec: {} }), 'Every 30 min')
  assert.equal(mv.triggerLine({ kind: 'check', text: '', spec: {} }), 'On a check')
  assert.equal(mv.runLine(null), 'Not run yet')
  assert.equal(mv.runLine({ status: 'failed', summary: 'Tests broke' }), 'Failed · Tests broke')
  assert.equal(mv.runLine({ status: 'needs-you', summary: '' }), 'Needs you')
  assert.equal(mv.runLine({ status: 'skipped', summary: 'Skipped: still running' }), 'Skipped: still running')
  assert.equal(mv.runLine({ status: 'running', summary: '' }), 'Running')
  assert.deepEqual(['running', 'ok', 'failed', 'needs-you', 'skipped', undefined].map(mv.dotClass),
    ['st-working', 'st-done', 'st-failed', 'st-needs', 'st-idle', 'st-idle'])
  assert.equal(mv.took({ startedAt: at(0), endedAt: at(3) }), '3 min')
  assert.equal(mv.took({ startedAt: at(0), endedAt: at(65) }), '1 h 5 min')
  assert.equal(mv.took({ startedAt: at(0), endedAt: null }), '')
  assert.equal(mv.isRunning({ lastRun: { status: 'running' } }), true)
  assert.equal(mv.isRunning({ lastRun: null }), false)
  assert.deepEqual(mv.listFrom([{ id: 'a' }]), [{ id: 'a' }])
  assert.deepEqual(mv.listFrom({ monitors: [{ id: 'a' }] }), [{ id: 'a' }])
})

test('monitor page: Details rows say who it runs as, where and since when', () => {
  assert.deepEqual(mv.facts({ agent: 'apologist', cwd: '/h/p', createdAt: 'T' }, (p: string) => `~${p}`, (t: string) => `at ${t}`),
    [['Runs as', 'apologist'], ['Folder', '~/h/p'], ['Created', 'T']])
  const created = mv.facts({ agent: null, createdAt: '2026-11-19T23:23:00Z' })[1][1]
  assert.match(created, /^Nov (19|20), 2026, \d{1,2}:\d{2}\s?[AP]M$/)
  assert.deepEqual(mv.facts({ agent: null }), [['Runs as', 'No agent']])
})

test('monitor page: what it does, then Run now / Pause, then a closed Details (brief and Delete), then runs', () => {
  const app = read('app.js')
  const page = app.slice(app.indexOf('function openMonitor('), app.indexOf('function runRow('))
  const order = ["m.description ? h('div', { class: 'desc' }", "'monitor-acts'", 'details,\n', "'Runs')"]
  const at = order.map((s) => page.indexOf(s))
  assert.ok(at.every((i) => i > 0), `missing: ${order.filter((_, i) => at[i] < 0)}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at)
  const details = page.slice(page.indexOf("h('details'"), page.indexOf('details.open = detailsOpen'))
  for (const s of ['m.instructions', 'MV.facts(', 'Delete monitor']) assert.ok(details.includes(s), s)
  assert.doesNotMatch(page, /'Trigger'/) // the schedule is in the header only
  assert.doesNotMatch(page, /open: true/) // closed by default
  assert.match(app, /m\.description \? h\('div', \{ class: 'desc one' \}/) // the list shows it too
})

test('monitors page: in the drawer right below Workers, served, live, no chat box', () => {
  const html = read('index.html')
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1])
  assert.equal(tabs[tabs.indexOf('workers') + 1], 'monitors')
  assert.match(html, /<section id="view-monitors"/)
  assert.ok(isWebFile('/monitors.js'))
  assert.ok(isWebFile('/monitors.0123456789.js'))
  const app = read('app.js')
  assert.match(app, /'agents', 'monitors'[,\]]/) // listens for the hub's "monitors" event
  assert.match(app, /if \(name === 'monitors'\) return monitorsChanged\(\)/)
  assert.match(app, /'No monitors yet\. Ask the Assistant to create one\.'/)
  const section = app.slice(app.indexOf('// ---------- Monitors'), app.indexOf('// ---------- Toolbox'))
  assert.doesNotMatch(section, /composer\(/)
  assert.match(read('styles.css'), /\.st-failed \{ background: var\(--danger\) \}/)
})
