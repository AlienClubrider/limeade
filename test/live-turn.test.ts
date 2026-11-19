import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const liveTurn = createRequire(import.meta.url)('../public/live-turn.js')

const view = (busy: boolean, ids: string[]) => ({
  chat: { busy, messages: ids.map((id) => ({ id })) },
  streaming: { old: 'Both Mac models are in. Checking that:', now: 'Working on it' } as Record<string, string>,
  liveSteps: { old: [{ tool: 'Bash', text: 'cat pull.log' }], now: [] } as Record<string, unknown[]>,
})

test('live turn: a turn the hub never finished (restart) is cleared once nothing runs', () => {
  const V = view(false, [])
  liveTurn.settle(V)
  assert.deepEqual(V.streaming, {})
  assert.deepEqual(V.liveSteps, {})
})

test('live turn: a landed reply (even an empty one) clears its live text; the running turn stays', () => {
  const V = view(true, ['old'])
  liveTurn.settle(V)
  assert.deepEqual(Object.keys(V.streaming), ['now'])
  assert.deepEqual(Object.keys(V.liveSteps), ['now'])
})

test('live turn: every script the page loads is served, tagged by its content', async () => {
  const { readFileSync } = await import('node:fs')
  const { isWebFile } = await import('../src/adapters/web-files.ts')
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const scripts = [...html.matchAll(/<script src="([^"?]+)/g)].map((m) => m[1]!)
  assert.ok(scripts.includes('/live-turn.js'))
  for (const src of scripts) {
    assert.equal(isWebFile(src), true, src)
    if (src !== '/sw.js') assert.equal(isWebFile(src.replace(/\.js$/, '.0123456789.js')), true, src)
  }
})

test('live turn: a page that loads mid-reply (or comes back after a hub restart) takes the hub\'s copy of it', () => {
  const V = view(true, ['old'])
  ;(V.chat as any).live = { messageId: 'now', text: 'Working on it. Restarting the hub now', steps: [{ tool: 'Bash', text: 'systemctl --user restart agent-hub' }] }
  liveTurn.settle(V)
  assert.equal(V.streaming.now, 'Working on it. Restarting the hub now')
  assert.equal(V.liveSteps.now!.length, 1)
  // We already have more than the hub's copy (pieces that came after it): keep ours.
  V.streaming.now = 'Working on it. Restarting the hub now. Back.'
  liveTurn.settle(V)
  assert.equal(V.streaming.now, 'Working on it. Restarting the hub now. Back.')
})

test('live turn: streamed pieces line up by where they go, so none doubles or goes missing', () => {
  assert.equal(liveTurn.addPiece('Hello wor', 'world', 6), 'Hello world') // overlaps what we have
  assert.equal(liveTurn.addPiece('Hello ', 'world', 6), 'Hello world')
  assert.equal(liveTurn.addPiece(undefined, 'Hi', 0), 'Hi')
  assert.equal(liveTurn.addPiece('Hello ', 'world', undefined), 'Hello world') // an older hub
  assert.equal(liveTurn.addPiece('Hel', 'world', 6), 'Helworld') // a gap: the next read of the chat fills it
})

test('live turn: text written before a step is a note on the way; only text since the latest step can be the reply', () => {
  const note = 'Now move the other five lectures into the course folder.'
  const text = `${note}\n\nAll done.`
  const steps = [{ tool: 'obsidian', text: '', at: note.length }]
  assert.deepEqual(liveTurn.split(note, steps), { notes: [{ before: 0, text: note }], now: '' })
  assert.deepEqual(liveTurn.split(text, steps), { notes: [{ before: 0, text: note }], now: 'All done.' })
})

test('live turn: notes land before the step each led into; steps without text between them add none', () => {
  const steps = [{ tool: 'a', text: '', at: 5 }, { tool: 'b', text: '', at: 5 }, { tool: 'c', text: '', at: 16 }]
  assert.deepEqual(liveTurn.split('Look.\n\nNow move.\n\nDone', steps), {
    notes: [{ before: 0, text: 'Look.' }, { before: 2, text: 'Now move.' }],
    now: 'Done',
  })
})

test('live turn: steps from an older hub (no place in the text) leave all the text as the reply', () => {
  assert.deepEqual(liveTurn.split('Checking that: done', [{ tool: 'Bash', text: 'ls' }]), { notes: [], now: 'Checking that: done' })
  assert.deepEqual(liveTurn.split(undefined, []), { notes: [], now: '' })
})

test('live turn: how long a step has run, said short and only once it is worth saying', () => {
  assert.equal(liveTurn.elapsed(12_000), '')
  assert.equal(liveTurn.elapsed(-5_000), '')
  assert.equal(liveTurn.elapsed(45_000), '45 s')
  assert.equal(liveTurn.elapsed(4 * 60_000 + 20_000), '4 min')
  assert.equal(liveTurn.elapsed(25 * 60_000), '25 min')
  assert.equal(liveTurn.elapsed(60 * 60_000), '1 h')
  assert.equal(liveTurn.elapsed(65 * 60_000), '1 h 5 min')
})

test('live turn: the assistant\'s [quiet] and [needs you] tags never show in its notes or the text so far', () => {
  const text = '[quiet] About to wait.\n\n[needs you] [quiet] Pick one?'
  const steps = [{ tool: 'Bash', text: 'sleep', at: 23 }]
  assert.deepEqual(liveTurn.split(text, steps), { notes: [{ before: 0, text: 'About to wait.' }], now: 'Pick one?' })
  assert.deepEqual(liveTurn.split('Not [quiet] here', []), { notes: [], now: 'Not [quiet] here' })
})

test('live turn: a tag still arriving in pieces shows as nothing, and plain text that only looks like one still shows', () => {
  for (const piece of ['[', '[qui', '[QUIET', '[needs y', '[quiet] [nee']) assert.deepEqual(liveTurn.split(piece, []), { notes: [], now: '' })
  assert.deepEqual(liveTurn.split('[quiet] Yes', []), { notes: [], now: 'Yes' })
  assert.deepEqual(liveTurn.split('[quick note]', []), { notes: [], now: '[quick note]' })
  assert.deepEqual(liveTurn.split('[1]', []), { notes: [], now: '[1]' })
})

test('live turn: tags opening later updates in one turn never show, even arriving in pieces, but code keeps them', () => {
  assert.deepEqual(liveTurn.split('Initial update\n\n[quiet] Second update\n\n[quiet] Third update', []), { notes: [], now: 'Initial update\n\nSecond update\n\nThird update' })
  for (const piece of ['[', '[qui', '[quiet', '[needs y']) assert.deepEqual(liveTurn.split(`Initial update\n\n${piece}`, []), { notes: [], now: 'Initial update' })
  const code = 'See:\n\n```\n[quiet] Routine\n```'
  assert.deepEqual(liveTurn.split(code, []), { notes: [], now: code })
  assert.deepEqual(liveTurn.split('Said [quiet] in passing', []), { notes: [], now: 'Said [quiet] in passing' })
  // After a step, too.
  const text = 'Looking.\n\n[quiet] Found it.\n\n[quiet] Fixed.'
  assert.deepEqual(liveTurn.split(text, [{ tool: 'Bash', text: 'x', at: 8 }]), { notes: [{ before: 0, text: 'Looking.' }], now: 'Found it.\n\nFixed.' })
})

test('live turn: the running reply shows above his messages still waiting their turn, else at the end', () => {
  const msgs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.equal(liveTurn.slot(msgs, ['b', 'c']), 1)
  assert.equal(liveTurn.slot(msgs, []), 3)
  assert.equal(liveTurn.slot(msgs, undefined), 3)
})

test('live turn: a long update folds to one plain line while the turn runs (issue #12)', () => {
  const note = 'The worker also found two **Sonar** issues: duplicate exception logging\nand an unused `catch` variable.\n\n- see [the report](https://example.com/r)'
  const line = liveTurn.oneLine(note)
  assert.equal(line, 'The worker also found two Sonar issues: duplicate exception logging and an unused catch variable. see the report')
  assert.ok(!line.includes('\n'))
  assert.equal(liveTurn.oneLine('```sh\nnpm test\n```'), 'npm test')
  assert.equal(liveTurn.oneLine(''), '')
})
