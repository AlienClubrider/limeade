import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  MAX_RUNS, monitorId, nextScheduled, parseSchedule, runOutcome, scheduleText, triggerFrom, type Monitor,
} from '../src/domain/monitors.ts'
import { Monitors } from '../src/app/monitors.ts'
import { AgentMonitorTurns } from '../src/app/monitor-turns.ts'
import { MonitorFiles, ShellCheck } from '../src/adapters/monitor-files.ts'
import { Conversations } from '../src/app/conversations.ts'
import { createHub } from '../src/adapters/http.ts'
import { bodyFrom, parseArgs } from '../src/cli/monitor.ts'
import type { Chat } from '../src/domain/chat.ts'
import type { MonitorTurn, TurnResult, TurnRequest } from '../src/ports.ts'

// ---------- schedules ----------

test('schedules in plain words', () => {
  assert.deepEqual(parseSchedule('every 30 min'), { every: 30 })
  assert.deepEqual(parseSchedule('Every 2 hours'), { every: 120 })
  assert.deepEqual(parseSchedule('every hour'), { every: 60 })
  assert.deepEqual(parseSchedule('hourly'), { every: 60 })
  assert.deepEqual(parseSchedule('every 1h'), { every: 60 })
  assert.deepEqual(parseSchedule('daily 21:00'), { at: '21:00', days: [0, 1, 2, 3, 4, 5, 6] })
  assert.deepEqual(parseSchedule('every day at 9pm'), { at: '21:00', days: [0, 1, 2, 3, 4, 5, 6] })
  assert.deepEqual(parseSchedule('weekdays 07:30'), { at: '07:30', days: [1, 2, 3, 4, 5] })
  assert.deepEqual(parseSchedule('weekends at 10am'), { at: '10:00', days: [0, 6] })
  assert.deepEqual(parseSchedule('mon,wed,fri 9am'), { at: '09:00', days: [1, 3, 5] })
  assert.deepEqual(parseSchedule('mondays 9:00'), { at: '09:00', days: [1] })
  assert.deepEqual(parseSchedule('mon-fri 8:15'), { at: '08:15', days: [1, 2, 3, 4, 5] })
  assert.deepEqual(parseSchedule('9pm daily'), { at: '21:00', days: [0, 1, 2, 3, 4, 5, 6] })
  for (const bad of ['', 'soon', 'daily', 'daily 25:00', 'every', 'every banana', 'mo 9:00', 'daily 9']) assert.equal(parseSchedule(bad), null, bad)
})

test('schedules read back the same way', () => {
  assert.equal(scheduleText({ every: 30 }), 'Every 30 min')
  assert.equal(scheduleText({ every: 120 }), 'Every 2 hours')
  assert.equal(scheduleText({ every: 90 }), 'Every 1 h 30 min')
  assert.equal(scheduleText({ at: '21:00', days: [0, 1, 2, 3, 4, 5, 6] }), 'Daily at 21:00')
  assert.equal(scheduleText({ at: '07:30', days: [1, 2, 3, 4, 5] }), 'Weekdays at 07:30')
  assert.equal(scheduleText({ at: '08:00', days: [1, 5] }), 'Mon, Fri at 08:00')
})

test('next run: intervals count from now, times find the next allowed day', () => {
  const fri = new Date(2026, 10, 20, 22, 0) // Friday 22:00 local
  assert.equal(nextScheduled({ every: 30 }, fri).getTime(), fri.getTime() + 30 * 60_000)
  assert.deepEqual(nextScheduled({ at: '21:00', days: [0, 1, 2, 3, 4, 5, 6] }, fri), new Date(2026, 10, 21, 21, 0))
  assert.deepEqual(nextScheduled({ at: '23:00', days: [0, 1, 2, 3, 4, 5, 6] }, fri), new Date(2026, 10, 20, 23, 0))
  assert.deepEqual(nextScheduled({ at: '07:30', days: [1, 2, 3, 4, 5] }, fri), new Date(2026, 10, 23, 7, 30)) // Monday
  // Exactly at the time: the next one, not this one again.
  assert.deepEqual(nextScheduled({ at: '22:00', days: [5] }, fri), new Date(2026, 10, 27, 22, 0))
})

test('triggers: a schedule as text, or a check with how often', () => {
  assert.deepEqual(triggerFrom('daily 21:00'), { kind: 'schedule', text: 'Daily at 21:00', spec: { at: '21:00', days: [0, 1, 2, 3, 4, 5, 6] } })
  const c = triggerFrom({ kind: 'check', command: 'ls inbox', every: '5 min' })
  assert.equal(c.kind, 'check')
  assert.deepEqual(c.spec, { command: 'ls inbox', every: 5 })
  assert.match(c.text, /^When `ls inbox` changes \(checked every 5 min\)$/)
  assert.deepEqual(triggerFrom({ kind: 'check', command: 'x' }).spec, { command: 'x', every: 10 })
  assert.throws(() => triggerFrom('whenever'), /Can't read "whenever"/)
  assert.throws(() => triggerFrom({ kind: 'check', command: ' ' }), /needs a command/)
  assert.throws(() => triggerFrom({ kind: 'check', command: 'x', every: '30 s' }), /Check every/)
  assert.throws(() => triggerFrom(null), /Give a trigger/)
})

test('ids from names, unique', () => {
  assert.equal(monitorId('Bible study!', new Set()), 'bible-study')
  assert.equal(monitorId('Bible study', new Set(['bible-study'])), 'bible-study-2')
  assert.equal(monitorId('***', new Set()), 'monitor')
})

test('a run reads its outcome from the last tagged line, else its last line', () => {
  assert.deepEqual(runOutcome('did things\nSUMMARY: 3 new posts', undefined, false), { status: 'ok', summary: '3 new posts' })
  assert.deepEqual(runOutcome('x\n**NEEDS-YOU:** pick a passage', undefined, false), { status: 'needs-you', summary: 'pick a passage' })
  assert.deepEqual(runOutcome('FAILED: site down', undefined, false), { status: 'failed', summary: 'site down' })
  assert.deepEqual(runOutcome('All good.\n\nNothing new today.', undefined, false), { status: 'ok', summary: 'Nothing new today.' })
  assert.deepEqual(runOutcome('half', 'Claude Code exited', false), { status: 'failed', summary: 'Claude Code exited' })
  assert.equal(runOutcome('SUMMARY: tried', undefined, true).status, 'needs-you')
  assert.equal(runOutcome('', undefined, false).summary, 'Done')
})

// ---------- the scheduler and runner ----------

function memoryStore() {
  const files = new Map<string, Monitor>()
  const logs = new Map<string, string>()
  return {
    files,
    logs,
    list: async () => [...files.values()].map((m) => structuredClone(m)),
    save: async (m: Monitor) => { files.set(m.id, structuredClone(m)) },
    remove: async (id: string) => { files.delete(id) },
    writeLog: async (id: string, run: string, text: string) => { logs.set(`${id}/${run}`, text) },
    readLog: async (id: string, run: string) => logs.get(`${id}/${run}`) ?? null,
    removeLog: async (id: string, run: string) => { logs.delete(`${id}/${run}`) },
  }
}

/** Turns that wait until the test ends them. */
function heldTurns() {
  const started: { t: MonitorTurn; end: (r: TurnResult) => void }[] = []
  const reattached: string[] = []
  return {
    started,
    reattached,
    run: (t: MonitorTurn) => new Promise<TurnResult>((end) => { started.push({ t, end }) }),
    reattach: async (h: string, t: MonitorTurn) => {
      reattached.push(h)
      t.onEvent({ type: 'resumed', text: 'picked up ', steps: [] })
      return { text: 'SUMMARY: finished after the restart', sessionId: null }
    },
  }
}

function setup(o: { checkOutput?: () => string; agents?: string[]; store?: ReturnType<typeof memoryStore>; turns?: ReturnType<typeof heldTurns>; authFailed?: (m: { id: string; name: string }) => void } = {}) {
  let now = new Date(2026, 10, 20, 9, 0).getTime()
  const store = o.store ?? memoryStore()
  const turns = o.turns ?? heldTurns()
  const events: string[] = []
  const checks: string[] = []
  const changes: unknown[] = []
  const monitors = new Monitors({
    store,
    turns,
    checks: { run: async (cmd) => { checks.push(cmd); return { output: o.checkOutput?.() ?? '', code: 0 } } },
    news: { addEvent: async (slug, kind, text) => { events.push(`${slug} ${kind}: ${text}`) } },
    resolveFolder: async (p) => (p.startsWith('/work') ? p : null),
    defaultFolder: '/work/dev',
    hasAgent: async (a) => (o.agents ?? ['apologist']).includes(a),
    ...(o.authFailed ? { authFailed: o.authFailed } : {}),
    now: () => now,
    log: () => {},
  })
  monitors.on('monitors', (e) => changes.push(e))
  return { monitors, store, turns, events, checks, changes, advance: (min: number) => { now += min * 60_000 }, at: () => now }
}

const flush = () => new Promise((r) => setImmediate(r))

test('create checks what it is given and schedules the first run', async () => {
  const { monitors } = setup()
  const m = await monitors.create({ name: 'Bible study', instructions: 'Post the reading', agent: 'apologist', trigger: 'every 30 min' })
  assert.equal(m.id, 'bible-study')
  assert.equal(m.cwd, '/work/dev')
  assert.equal(m.agent, 'apologist')
  assert.equal(m.trigger.text, 'Every 30 min')
  assert.equal(m.nextRunAt, new Date(2026, 10, 20, 9, 30).toISOString())
  assert.equal(m.lastRun, null)
  assert.deepEqual(m.runs, [])
  assert.equal(m.description, '') // none given: nothing, never the instructions
  await assert.rejects(monitors.create({ name: '', instructions: 'x', trigger: 'hourly' }), /name/)
  await assert.rejects(monitors.create({ name: 'a', instructions: ' ', trigger: 'hourly' }), /instructions are empty/)
  await assert.rejects(monitors.create({ name: 'a', instructions: 'x', trigger: 'soonish' }), /Can't read/)
  await assert.rejects(monitors.create({ name: 'a', instructions: 'x', trigger: 'hourly', agent: 'nobody' }), /no agent named nobody/)
  await assert.rejects(monitors.create({ name: 'a', instructions: 'x', trigger: 'hourly', cwd: '/etc' }), /folder/)
  assert.equal((await monitors.create({ name: 'a', instructions: 'x', trigger: 'hourly', agent: '-' })).agent, null)
})

test('a due schedule runs once, with its agent, folder and instructions; a fine run is quiet', async () => {
  const { monitors, turns, events, advance } = setup()
  await monitors.create({ name: 'Bible study', instructions: 'Post the reading', agent: 'apologist', trigger: 'every 30 min' })
  await monitors.tick()
  assert.equal(turns.started.length, 0)
  advance(30)
  await monitors.tick()
  assert.equal(turns.started.length, 1)
  const { t, end } = turns.started[0]!
  assert.equal(t.prompt, 'Post the reading')
  assert.equal(t.agent, 'apologist')
  assert.equal(t.cwd, '/work/dev')
  assert.match(t.note, /monitor "Bible study".*SUMMARY:/)
  let listed = monitors.list()[0]!
  assert.equal(listed.lastRun?.status, 'running')
  assert.equal(listed.nextRunAt, new Date(2026, 10, 20, 10, 0).toISOString())
  // Live log while it runs.
  t.onEvent({ type: 'text', text: 'Reading today’s passage.' })
  t.onEvent({ type: 'step', step: { tool: 'Bash', text: 'ls', label: 'Running ls' } })
  assert.match((await monitors.runLog('bible-study', listed.lastRun!.id)).log, /passage\.\n› Running ls/)
  end({ text: 'Posted.\nSUMMARY: Posted John 3', sessionId: 's' })
  await flush()
  await flush()
  listed = monitors.list()[0]!
  assert.equal(listed.lastRun?.status, 'ok')
  assert.equal(listed.lastRun?.summary, 'Posted John 3')
  assert.ok(listed.lastRun?.endedAt)
  assert.match((await monitors.runLog('bible-study', listed.lastRun!.id)).log, /Running ls/)
  assert.deepEqual(events, [])
})

test('failed and needs-you runs tell the Assistant like worker news', async () => {
  const { monitors, turns, events } = setup()
  await monitors.create({ name: 'Bible study', instructions: 'x', trigger: 'hourly' })
  await monitors.runNow('bible-study')
  turns.started[0]!.end({ text: 'NEEDS-YOU: which translation?', sessionId: null })
  await flush(); await flush()
  await monitors.runNow('bible-study')
  turns.started[1]!.end({ text: '', sessionId: null, error: 'Claude Code exited' })
  await flush(); await flush()
  assert.deepEqual(events, [
    'monitor-bible-study reported: needs-decision: monitor "Bible study": which translation?',
    'monitor-bible-study reported: failed: monitor "Bible study": Claude Code exited',
  ])
  assert.deepEqual(monitors.get('bible-study').runs.map((r) => r.status), ['failed', 'needs-you'])
})

test('approvals are declined (nobody to ask) and the run needs the user', async () => {
  const { monitors, turns } = setup()
  await monitors.create({ name: 'm', instructions: 'x', trigger: 'hourly' })
  await monitors.runNow('m')
  const answers: string[] = []
  turns.started[0]!.t.onEvent({ type: 'approval', request: { tool: 'Bash', text: 'rm -rf build', description: '', alwaysLabel: '' }, answer: (d) => answers.push(d) })
  turns.started[0]!.end({ text: 'SUMMARY: skipped cleanup', sessionId: null })
  await flush(); await flush()
  assert.deepEqual(answers, ['no'])
  assert.equal(monitors.list()[0]!.lastRun?.status, 'needs-you')
})

test('no overlap: due while running is skipped and noted; run now says 409', async () => {
  const { monitors, turns, advance } = setup()
  await monitors.create({ name: 'm', instructions: 'x', trigger: 'every 10 min' })
  advance(10)
  await monitors.tick()
  advance(10)
  await monitors.tick()
  assert.equal(turns.started.length, 1)
  const runs = monitors.get('m').runs
  assert.deepEqual(runs.map((r) => r.status), ['skipped', 'running'])
  assert.match(runs[0]!.summary, /still going/)
  assert.equal(monitors.list()[0]!.lastRun?.status, 'running') // the list shows the one going
  await assert.rejects(monitors.runNow('m'), (e: any) => e.status === 409)
})

test('paused monitors do not run; resume schedules from now', async () => {
  const { monitors, turns, advance } = setup()
  await monitors.create({ name: 'm', instructions: 'x', trigger: 'every 10 min' })
  const paused = await monitors.update('m', { enabled: false })
  assert.equal(paused.enabled, false)
  assert.equal(paused.nextRunAt, null)
  advance(60)
  await monitors.tick()
  assert.equal(turns.started.length, 0)
  const back = await monitors.update('m', { enabled: true })
  assert.equal(Date.parse(back.nextRunAt!), new Date(2026, 10, 20, 10, 10).getTime())
  // Run now works while paused too.
  await monitors.update('m', { enabled: false })
  await monitors.runNow('m')
  assert.equal(turns.started.length, 1)
})

test('a description is one tidy line, shown in the list and detail, and can be changed or cleared', async () => {
  const { monitors, store } = setup()
  const m = await monitors.create({ name: 'Prep', description: '  Prepares today’s\n reading  ', instructions: 'A long brief', trigger: 'daily 05:00' })
  assert.equal(m.description, 'Prepares today’s reading')
  assert.equal(monitors.list()[0]!.description, 'Prepares today’s reading')
  assert.equal((await store.list())[0]!.description, 'Prepares today’s reading')
  const e = await monitors.update('prep', { description: 'Sets up the study' })
  assert.equal(e.description, 'Sets up the study')
  assert.equal(e.instructions, 'A long brief')
  assert.equal(e.trigger.text, 'Daily at 05:00') // the schedule is untouched
  assert.equal((await monitors.update('prep', { description: '' })).description, '')
  await assert.rejects(monitors.update('prep', { description: 'x'.repeat(201) }), /one short line/)
  await assert.rejects(monitors.update('prep', { description: 5 }), /must be text/)
})

test('edits change the trigger and what runs', async () => {
  const { monitors } = setup()
  await monitors.create({ name: 'm', instructions: 'x', trigger: 'hourly' })
  const e = await monitors.update('m', { name: 'Morning news', instructions: 'y', trigger: 'weekdays 07:30', agent: 'apologist' })
  assert.equal(e.id, 'm') // the id stays
  assert.equal(e.name, 'Morning news')
  assert.equal(e.instructions, 'y')
  assert.equal(e.trigger.text, 'Weekdays at 07:30')
  assert.equal(e.nextRunAt, new Date(2026, 10, 23, 7, 30).toISOString())
  await assert.rejects(monitors.update('m', { enabled: 'yes' }), /true or false/)
  await assert.rejects(monitors.update('nope', {}), (err: any) => err.status === 404)
})

test('a check runs the job only when its output changes (the first look just records it)', async () => {
  let out = 'a'
  const { monitors, turns, checks, advance } = setup({ checkOutput: () => out })
  await monitors.create({ name: 'inbox', instructions: 'Sort new mail', trigger: { kind: 'check', command: 'ls ~/mail', every: 5 } })
  for (let i = 0; i < 3; i++) {
    advance(5)
    await monitors.tick()
  }
  assert.equal(checks.length, 3)
  assert.equal(turns.started.length, 0)
  out = 'a\nb'
  advance(5)
  await monitors.tick()
  assert.equal(turns.started.length, 1)
  assert.match(turns.started[0]!.t.prompt, /^Sort new mail\n\nThe check `ls ~\/mail` now prints:\na\nb$/)
  assert.equal(monitors.get('inbox').runs[0]!.reason, 'check')
  advance(5)
  await monitors.tick()
  assert.equal(turns.started.length, 1)
})

test('history keeps the newest 50 runs and drops the old logs', async () => {
  const { monitors, turns, store } = setup()
  await monitors.create({ name: 'm', instructions: 'x', trigger: 'hourly' })
  for (let i = 0; i < MAX_RUNS + 3; i++) {
    await monitors.runNow('m')
    turns.started.at(-1)!.end({ text: `SUMMARY: run ${i}`, sessionId: null })
    await flush(); await flush()
  }
  const runs = monitors.get('m').runs
  assert.equal(runs.length, MAX_RUNS)
  assert.equal(runs[0]!.summary, `run ${MAX_RUNS + 2}`)
  assert.equal(store.logs.size, MAX_RUNS)
})

test('a restarted hub keeps the schedule and picks up a run that was going', async () => {
  const store = memoryStore()
  const first = setup({ store })
  await first.monitors.create({ name: 'm', instructions: 'x', trigger: 'every 30 min' })
  await first.monitors.create({ name: 'n', instructions: 'x', trigger: 'every 30 min' })
  await first.monitors.runNow('m')
  first.turns.started[0]!.t.onStart!('keeper-1') // runs on in its keeper
  await first.monitors.runNow('n') // this one can't outlive the hub
  await flush()
  const saved = store.files.get('m')!
  assert.equal(saved.runs[0]!.handle, 'keeper-1')

  const second = setup({ store })
  await second.monitors.load()
  await flush(); await flush()
  assert.deepEqual(second.turns.reattached, ['keeper-1'])
  const m = second.monitors.get('m')
  assert.equal(m.runs[0]!.status, 'ok')
  assert.equal(m.runs[0]!.summary, 'finished after the restart')
  assert.equal('handle' in m.runs[0]!, false)
  assert.equal(m.nextRunAt, saved.nextRunAt)
  const n = second.monitors.get('n')
  assert.equal(n.runs[0]!.status, 'failed')
  assert.match(n.runs[0]!.summary, /restarted/)
})

test('deleting stops its run and forgets it', async () => {
  const { monitors, turns, store } = setup()
  await monitors.create({ name: 'm', instructions: 'x', trigger: 'hourly' })
  await monitors.runNow('m')
  await monitors.remove('m')
  assert.equal(turns.started[0]!.t.signal.aborted, true)
  turns.started[0]!.end({ text: '', sessionId: null, error: 'Stopped' })
  await flush(); await flush()
  assert.equal(store.files.has('m'), false)
  assert.deepEqual(monitors.list(), [])
  await assert.rejects(monitors.remove('m'), (e: any) => e.status === 404)
})

test("a run that fails on Claude's sign-in is reported; after the sign-in it runs once more", async () => {
  const failedOn: string[] = []
  const { monitors, turns } = setup({ authFailed: (m) => failedOn.push(m.id) })
  await monitors.create({ name: 'Prep', instructions: 'go', trigger: 'daily 05:00' })
  await monitors.runNow('prep')
  turns.started[0]!.end({ text: '', sessionId: null, error: 'Failed to authenticate: OAuth session expired and could not be refreshed' })
  await flush()
  await flush()
  assert.deepEqual(failedOn, ['prep'])
  // Other failures aren't the sign-in's, even when the run's own words mention one.
  await monitors.runNow('prep')
  turns.started[1]!.end({ text: 'Checked the bank: Not logged in, Please run /login', sessionId: null, error: 'API Error: 529 Overloaded' })
  await flush()
  await flush()
  assert.deepEqual(failedOn, ['prep'])
  await monitors.retry('prep')
  assert.equal(monitors.get('prep').lastRun!.reason, 'sign-in')
  await monitors.retry('prep') // running already: nothing
  await monitors.retry('gone')
  assert.equal(turns.started.length, 3)
})

// ---------- the turn adapter ----------

test('runs go to the engine the Assistant is on, in auto mode, and can be picked up again', async () => {
  const seen: TurnRequest[] = []
  const reattached: string[] = []
  const engine = {
    run: async (r: TurnRequest) => { seen.push(r); r.onStart?.('k-1'); return { text: 'SUMMARY: ok', sessionId: 's' } },
    reattach: async (h: string, r: TurnRequest) => { reattached.push(`${h}:${r.model}`); return { text: 'ok', sessionId: null } },
  }
  let assistant = { agent: 'claude' as const, model: 'claude:opus', effort: 'high' as const }
  const turns = new AgentMonitorTurns({ engines: { claude: engine }, assistant: () => assistant })
  let handle = ''
  const t: MonitorTurn = { prompt: 'p', cwd: '/w', agent: 'apologist', note: 'n', signal: new AbortController().signal, onEvent: () => {}, onStart: (h) => { handle = h } }
  await turns.run(t)
  assert.equal(seen[0]!.mode, 'auto')
  assert.equal(seen[0]!.model, 'opus')
  assert.equal(seen[0]!.agent, 'apologist')
  assert.equal(seen[0]!.cwd, '/w')
  assert.equal(seen[0]!.sessionId, null)
  assert.equal(seen[0]!.appendSystemPrompt, 'n')
  assistant = { agent: 'claude', model: 'claude:sonnet', effort: 'high' }
  await turns.reattach(handle, t)
  assert.deepEqual(reattached, ['k-1:opus']) // the model it started on
  assert.equal(await turns.reattach('junk', t), null)
  assistant = { agent: 'codex' as any, model: 'claude:opus', effort: 'high' }
  await assert.rejects(turns.run(t), /can't run/)
})

test("runs on Claude's own models get the background token; local models never do", async () => {
  const seen: TurnRequest[] = []
  const engine = { run: async (r: TurnRequest) => { seen.push(r); return { text: 'ok', sessionId: null } } }
  let assistant: { agent: 'claude'; model: string; effort: 'high' } = { agent: 'claude', model: 'claude:opus', effort: 'high' }
  let env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 't' }
  const turns = new AgentMonitorTurns({ engines: { claude: engine, local: engine }, assistant: () => assistant, claudeEnv: () => env })
  const t: MonitorTurn = { prompt: 'p', cwd: '/w', agent: null, note: 'n', signal: new AbortController().signal, onEvent: () => {} }
  await turns.run(t)
  assert.deepEqual(seen[0]!.env, { CLAUDE_CODE_OAUTH_TOKEN: 't' })
  env = {}
  await turns.run(t)
  assert.equal(seen[1]!.env, undefined)
  env = { CLAUDE_CODE_OAUTH_TOKEN: 't' }
  assistant = { agent: 'claude', model: 'local:llama3.1-8b', effort: 'high' }
  await turns.run(t)
  assert.equal(seen[2]!.env, undefined)
})

// ---------- files and checks ----------

test('monitor files and logs round-trip, and ids stay inside the folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'monitors-'))
  const files = new MonitorFiles(dir)
  const m: Monitor = { id: 'm', name: 'M', instructions: 'x', agent: null, cwd: '/', trigger: triggerFrom('hourly'), enabled: true, createdAt: 't', nextRunAt: null, runs: [] }
  await files.save(m)
  await files.writeLog('m', 'r1', 'hello')
  assert.deepEqual(await files.list(), [m])
  assert.equal(await files.readLog('m', 'r1'), 'hello')
  assert.equal(await files.readLog('m', 'nope'), null)
  await assert.rejects(files.writeLog('../x', 'r', 'y'), /Bad monitor id/)
  await assert.rejects(files.writeLog('m', '../r', 'y'), /Bad monitor id/)
  await files.remove('m')
  assert.deepEqual(await files.list(), [])
})

test('a check gives the command’s output, and gives up on a slow one', async () => {
  const cwd = realpathSync(tmpdir())
  assert.deepEqual(await new ShellCheck().run('pwd; echo hi >&2; exit 3', cwd), { output: cwd, code: 3 })
  const slow = await new ShellCheck({ timeoutMs: 200 }).run('sleep 5', cwd)
  assert.match(slow.error!, /longer than/)
})

// ---------- the CLI ----------

test('the CLI turns flags into what the API takes', () => {
  const { words, flags } = parseArgs(['Bible study', '--when', 'daily 21:00', '--agent', 'apologist', '--text', 'Post it', '--paused'])
  assert.deepEqual(words, ['Bible study'])
  assert.deepEqual(bodyFrom(flags), { trigger: { kind: 'schedule', text: 'daily 21:00' }, instructions: 'Post it', agent: 'apologist', enabled: false })
  assert.deepEqual(bodyFrom(parseArgs(['--check', 'ls', '--every', '5 min', '--agent', '-', '--file', 'f']).flags, () => 'from file'), {
    trigger: { kind: 'check', command: 'ls', every: '5 min' }, agent: null, instructions: 'from file',
  })
  assert.deepEqual(bodyFrom(parseArgs(['--description', 'Prepares the reading']).flags), { description: 'Prepares the reading' })
})

// ---------- the API ----------

test('the API: list, create, detail, run, run log, pause, delete', async () => {
  const KEY = 'k'.repeat(40)
  const chats = new Map<string, Chat>()
  const conversations = new Conversations({
    store: { list: () => [...chats.values()], get: (id) => chats.get(id) ?? null, save: async (c) => { chats.set(c.id, c) }, remove: async (id) => { chats.delete(id) } },
    notices: { since: () => [], append: async (n) => ({ ...n, seq: 1, at: 'now' }) },
    engines: { claude: { run: async () => ({ text: '', sessionId: null }) }, local: { run: async () => ({ text: '', sessionId: null }) } },
    fleet: { lines: async () => [], cursor: async () => 0, lastWake: async () => 0, setLastWake: async () => {} },
    fleetMode: { get: async () => 'claude-app', set: async () => {} },
    claudeVersions: { get: () => ({}), set: async () => {} },
    defaultChatModel: 'local:m',
  })
  const { monitors, turns } = setup()
  const streamed: string[] = []
  const hub = createHub({
    key: KEY, conversations, notices: { since: () => [], append: async (n) => ({ ...n, seq: 1, at: 'now' }) },
    fleetMode: { get: async () => 'claude-app', set: async () => {} }, localModels: { groups: async () => [] },
    claudeVersions: { get: () => ({}), set: async () => {} }, toolbox: null,
    oneShot: { claude: { complete: async () => '' }, local: { complete: async () => '' } },
    workers: { list: async () => [], get: async () => null, stop: async () => {} },
    monitors, version: 't', log: () => {},
  })
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } })
  const stream = await fetch(`${base}/stream`, { headers: { Authorization: `Bearer ${KEY}` } })
  const reader = stream.body!.getReader()
  try {
    assert.equal((await fetch(`${base}/monitors`, { headers: { Authorization: 'Bearer wrong' } })).status, 401) // same sign-in as everything else
    assert.deepEqual(await (await call('/monitors')).json(), [])
    const made = await call('/monitors', { method: 'POST', body: JSON.stringify({ name: 'Bible study', instructions: 'Post', trigger: 'daily 21:00' }) })
    assert.equal(made.status, 201)
    assert.equal((await made.json()).id, 'bible-study')
    assert.equal((await call('/monitors', { method: 'POST', body: JSON.stringify({ name: 'x', instructions: 'y', trigger: 'nope' }) })).status, 400)
    const list = await (await call('/monitors')).json()
    assert.deepEqual(Object.keys(list[0]).sort(), ['agent', 'description', 'enabled', 'id', 'lastRun', 'name', 'nextRunAt', 'trigger'])
    assert.deepEqual(Object.keys(list[0].trigger).sort(), ['kind', 'spec', 'text'])
    const ran = await call('/monitors/bible-study/run', { method: 'POST' })
    assert.equal(ran.status, 202)
    const run = await ran.json()
    assert.equal(run.status, 'running')
    assert.equal((await call('/monitors/bible-study/run', { method: 'POST' })).status, 409)
    turns.started[0]!.end({ text: 'SUMMARY: posted', sessionId: null })
    await flush(); await flush()
    const detail = await (await call('/monitors/bible-study')).json()
    for (const k of ['instructions', 'cwd', 'createdAt', 'runs']) assert.ok(k in detail, k)
    assert.equal(detail.runs[0].summary, 'posted')
    const log = await (await call(`/monitors/bible-study/runs/${run.id}`)).json()
    assert.equal(log.log, 'SUMMARY: posted')
    assert.equal((await call('/monitors/bible-study/runs/nope')).status, 404)
    const paused = await (await call('/monitors/bible-study', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).json()
    assert.equal(paused.enabled, false)
    assert.equal((await call('/monitors/bible-study', { method: 'DELETE' })).status, 200)
    assert.equal((await call('/monitors/bible-study')).status, 404)
    // Every change went out on the live stream.
    while (!/event: monitors/.test(streamed.join(''))) streamed.push(new TextDecoder().decode((await reader.read()).value))
  } finally {
    await reader.cancel()
    hub.close()
    hub.closeAllConnections()
  }
})
