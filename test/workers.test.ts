import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isActive, jobFor, latestActivity, latestOf, paneStateFrom, parseRegistry, parseStatus, sortWorkers, stateWords, transcriptPath, workerState } from '../src/domain/workers.ts'

test('registry and status lines parse', () => {
  const reg = parseRegistry('u1\tsession_1\tdeveloper\tNotes app · fixes\t/home/h/dev/notes-app\tcc-notes-app-fixes\n\nbad line\n')
  assert.deepEqual(reg, [{ uuid: 'u1', remoteId: 'session_1', agent: 'developer', title: 'Notes app · fixes', dir: '/home/h/dev/notes-app', slug: 'cc-notes-app-fixes' }])
  const lines = parseStatus('2026-11-13T12:45:16Z working: Deploying\n2026-11-13T12:45:46Z done: Live: v2\njunk')
  assert.deepEqual(lines.map((l) => l.state), ['working', 'done'])
  assert.equal(lines[1]!.text, 'Live: v2')
})

test('job comes from the newest backlog row for that worker', () => {
  const backlog = '1\tdone\tNotes app · fixes\tFix search\t-\tt\n2\trunning\tNotes app · fixes\tSaved page v2\t-\tt\n3\tqueued\t-\tOther\t-\tt'
  assert.equal(jobFor(backlog, 'Notes app · fixes'), 'Saved page v2')
  assert.equal(jobFor(backlog, 'Nobody'), null)
})

test('one state per worker', () => {
  const l = (state: string) => ({ at: 't', state, text: '' })
  assert.equal(workerState('prompt', l('working')), 'needs')
  assert.equal(workerState('idle', l('needs-decision')), 'needs')
  assert.equal(workerState('busy', l('done')), 'working')
  assert.equal(workerState('idle', l('done')), 'done')
  assert.equal(workerState('idle', l('working')), 'idle')
  assert.equal(workerState('gone', l('working')), 'done')
  assert.equal(workerState('gone', l('needs-decision')), 'done') // an old report can't outlive its session
  assert.equal(workerState('idle', undefined), 'idle')
})

test('terminal reading matches fleet', () => {
  assert.equal(paneStateFrom(null), 'gone')
  assert.equal(paneStateFrom('foo\nDo you want to proceed?\n'), 'prompt')
  assert.equal(paneStateFrom('✻ Working… (esc to interrupt)'), 'busy')
  assert.equal(paneStateFrom('❯ \n  auto mode on'), 'idle')
  assert.equal(paneStateFrom('$ '), 'stopped')
  assert.equal(stateWords('needs-decision'), 'Needs you')
})

test('only workers with a live tmux session are active', () => {
  assert.equal(isActive('gone'), false)
  for (const p of ['busy', 'idle', 'prompt', 'stopped'] as const) assert.equal(isActive(p), true)
})

test('needs-you first, then working, newest first', () => {
  const w = (id: string, state: 'working' | 'needs' | 'idle' | 'done', at: string) => ({ id, title: id, state, now: '', at })
  assert.deepEqual(sortWorkers([w('a', 'done', '3'), w('b', 'working', '1'), w('c', 'needs', '0'), w('d', 'working', '2')]).map((x) => x.id), ['c', 'd', 'b', 'a'])
})

test('within a state, the most recently active worker comes first, whatever it last reported', () => {
  const w = (id: string, state: 'working' | 'idle', at: string, activeAt?: string) => ({ id, title: id, state, now: '', at, activeAt })
  const list = [
    w('idle-new', 'idle', '2026-11-16T10:00:00Z'),
    w('old-report-busy-now', 'working', '2026-11-16T08:00:00Z', '2026-11-16T10:05:00Z'),
    w('fresh-report', 'working', '2026-11-16T09:59:00Z', '2026-11-16T09:59:00Z'),
  ]
  assert.deepEqual(sortWorkers(list).map((x) => x.id), ['old-report-busy-now', 'fresh-report', 'idle-new'])
})

test('latest of two times copes with a missing one', () => {
  assert.equal(latestOf('2026-11-16T10:00:00Z', '2026-11-16T09:00:00Z'), '2026-11-16T10:00:00Z')
  assert.equal(latestOf('2026-11-16T09:00:00.000Z', '2026-11-16T10:00:00Z'), '2026-11-16T10:00:00Z')
  assert.equal(latestOf(null, 't'), 't')
  assert.equal(latestOf(undefined, null), null)
})

test('a worker\'s "now" comes from the end of its transcript', () => {
  const line = (o: object) => JSON.stringify(o)
  const tail = [
    '{"cut line from the middle',
    line({ type: 'assistant', timestamp: 't1', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/notes.md' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    line({ type: 'assistant', timestamp: 't2', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } }),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } }),
  ].join('\n')
  assert.deepEqual(latestActivity(tail), { label: 'Run the tests', at: 't2' })
  assert.deepEqual(latestActivity(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } })), { label: 'Writing', at: null })
  assert.equal(latestActivity(''), null)
  assert.equal(transcriptPath('/h/.claude', '/home/h/dev/notes-app', 'u1'), '/h/.claude/projects/-home-h-dev-notes-app/u1.jsonl')
})
