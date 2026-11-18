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

test('live turn: the assistant\'s [quiet] and [needs you] tags never show in the reply so far, even in pieces', () => {
  assert.equal(liveTurn.untag('[quiet] Yes, found it.'), 'Yes, found it.')
  assert.equal(liveTurn.untag('[needs you] [quiet] Pick one?'), 'Pick one?')
  for (const piece of ['[', '[qui', '[QUIET', '[needs y', '[quiet] [nee']) assert.equal(liveTurn.untag(piece), '')
  assert.equal(liveTurn.untag('Not [quiet] here'), 'Not [quiet] here')
  assert.equal(liveTurn.untag('[quick note]'), '[quick note]')
  assert.equal(liveTurn.untag(undefined), '')
})

test('live turn: tags opening later updates in one turn never show, even arriving in pieces, but code keeps them', () => {
  assert.equal(liveTurn.untag('Initial update\n\n[quiet] Second update\n\n[quiet] Third update'), 'Initial update\n\nSecond update\n\nThird update')
  for (const piece of ['[', '[qui', '[quiet', '[needs y']) assert.equal(liveTurn.untag(`Initial update\n\n${piece}`), 'Initial update')
  const code = 'See:\n\n```\n[quiet] Routine\n```'
  assert.equal(liveTurn.untag(code), code)
  assert.equal(liveTurn.untag('Said [quiet] in passing'), 'Said [quiet] in passing')
})

test('live turn: the running reply shows above his messages still waiting their turn, else at the end', () => {
  const msgs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.equal(liveTurn.slot(msgs, ['b', 'c']), 1)
  assert.equal(liveTurn.slot(msgs, []), 3)
  assert.equal(liveTurn.slot(msgs, undefined), 3)
})
