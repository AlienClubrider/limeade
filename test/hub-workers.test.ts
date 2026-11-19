// Built-in workers end to end inside the hub: the Assistant starts one, it reports with the bundled
// `fleet` command, and what needs the Assistant lands in events.log and wakes it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Conversations } from '../src/app/conversations.ts'
import { HubWorkers } from '../src/app/workers.ts'
import { FleetDir, HubFleetMode } from '../src/adapters/files.ts'
import { workerSlug } from '../src/domain/fleet.ts'
import type { Chat } from '../src/domain/chat.ts'
import type { ChatStore, Notice, NoticeLog, TurnRequest, TurnResult } from '../src/ports.ts'

const run = promisify(execFile)
const FLEET = new URL('../bin/fleet', import.meta.url).pathname

class MemStore implements ChatStore {
  chats = new Map<string, Chat>()
  list() { return [...this.chats.values()] }
  get(id: string) { return this.chats.get(id) ?? null }
  async save(c: Chat) { this.chats.set(c.id, structuredClone(c)) }
  async remove(id: string) { this.chats.delete(id) }
}

class MemNotices implements NoticeLog {
  items: Notice[] = []
  since(seq: number) { return this.items.filter((n) => n.seq > seq) }
  async append(n: Omit<Notice, 'seq' | 'at'>) {
    const saved = { ...n, seq: this.items.length + 1, at: 'now' }
    this.items.push(saved)
    return saved
  }
}

const folders = {
  home: '/h',
  resolve: async (p: string) => (p.startsWith('/h/') ? p : null),
  list: async () => [],
  search: async () => [],
}

/** The worker's agent: runs the bundled `fleet` the way a real agent's shell would, with the turn's env. */
function setup(reply: (req: TurnRequest, fleet: (...args: string[]) => Promise<string>) => Promise<TurnResult>) {
  const dir = mkdtempSync(join(tmpdir(), 'limeade-test-fleet-'))
  const records = new FleetDir(dir)
  const calls: TurnRequest[] = []
  const engine = {
    run: async (req: TurnRequest) => {
      calls.push(req)
      const fleet = async (...args: string[]) => (await run(FLEET, args, { env: { ...process.env, FLEET_HOME: dir, LIMEADE_NODE: process.execPath, ...req.env } })).stdout
      return reply(req, fleet)
    },
  }
  const c = new Conversations({
    store: new MemStore(),
    notices: new MemNotices(),
    engines: { claude: engine, local: engine },
    fleet: records,
    fleetMode: new HubFleetMode(),
    claudeVersions: { get: () => ({}), set: async () => {} },
    defaultChatModel: 'claude:opus',
    folders,
    defaultFolder: '/h/dev',
    fleetNotes: { kind: 'builtin' },
  })
  const workers = new HubWorkers({ conversations: c, records, machine: 'This computer', hasPersona: async (id) => id === 'developer' })
  return { c, workers, records, dir, calls, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const idle = (c: Conversations, id: string) =>
  new Promise<void>((resolve) => {
    const check = () => (c.get(id).busy ? setTimeout(check, 5) : resolve())
    check()
  })
const settle = () => new Promise((r) => setTimeout(r, 30))

test('a worker reports done with fleet status; the Assistant is woken with the event', async () => {
  const t = setup(async (req, fleet) => {
    if (req.env?.FLEET_SLUG) {
      assert.match(await fleet('status', 'working', 'on it'), /recorded for dark-theme/)
      await fleet('status', 'done', 'dark theme added, tests pass')
      return { text: 'Done.', sessionId: 'w-1' }
    }
    return { text: '[quiet] **TL;DR:** noted', sessionId: 'a-1' }
  })
  try {
    const w = await t.workers.start({ persona: 'developer', title: 'Dark theme', folder: '/h/dev/app', brief: 'Add a dark theme' })
    assert.equal(w.id, 'dark-theme')
    assert.equal(w.agent, 'developer')
    await idle(t.c, w.chatId)
    await t.workers.watch()
    const events = readFileSync(join(t.dir, 'events.log'), 'utf8').trim().split('\n')
    assert.equal(events.length, 1)
    assert.match(events[0]!, /^1 \S+Z dark-theme reported: done: dark theme added, tests pass$/)
    assert.equal(await t.c.checkFleet(), true)
    await idle(t.c, 'assistant')
    const wake = t.calls.at(-1)!
    assert.match(wake.prompt, /\[fleet event\] Fleet events \(handle each, then fleet ack\):\n1 .* dark-theme reported: done/)
    const listed = await t.workers.list()
    assert.deepEqual(listed.map((x) => [x.id, x.state, x.now, x.agent]), [['dark-theme', 'done', 'dark theme added, tests pass', 'developer']])
    // Seen once: the next look adds nothing.
    await t.workers.watch()
    assert.equal(readFileSync(join(t.dir, 'events.log'), 'utf8').trim().split('\n').length, 1)
  } finally {
    t.done()
  }
})

test('a worker turn that ends without a report, or fails, is an event too; a stopped worker leaves the list', async () => {
  let fail = false
  const t = setup(async (req) => (req.env?.FLEET_SLUG ? (fail ? { text: '', sessionId: 'w', error: 'model went away' } : { text: 'hmm', sessionId: 'w' }) : { text: 'ok', sessionId: 'a' }))
  try {
    const w = await t.workers.start({ persona: '-', title: 'Quiet one', folder: '/h/dev', brief: 'go' })
    await idle(t.c, w.chatId)
    await settle()
    assert.equal((await t.workers.list())[0]!.agent, null) // a plain session names no agent
    fail = true
    await t.workers.send('quiet-one', 'try again')
    await idle(t.c, w.chatId)
    await settle()
    const events = readFileSync(join(t.dir, 'events.log'), 'utf8').trim().split('\n')
    assert.match(events[0]!, / quiet-one idle: finished a turn without a status line$/)
    assert.match(events[1]!, / quiet-one stopped: the turn failed: .*model went away/)
    await t.workers.stop('quiet-one')
    assert.deepEqual(await t.workers.list(), [])
    await assert.rejects(t.workers.send('quiet-one', 'more'), /No such worker/)
  } finally {
    t.done()
  }
})

test('a worker needs a real persona, a title and a brief', async () => {
  const t = setup(async () => ({ text: 'ok', sessionId: 's' }))
  try {
    await assert.rejects(t.workers.start({ persona: 'nobody', title: 'X', folder: '/h/dev', brief: 'b' }), /no agent named nobody/)
    await assert.rejects(t.workers.start({ persona: '-', title: ' ', folder: '/h/dev', brief: 'b' }), /title/)
    await assert.rejects(t.workers.start({ persona: '-', title: 'X', folder: '/h/dev', brief: '' }), /brief/)
    await assert.rejects(t.workers.start({ persona: '-', title: 'X', folder: '/etc', brief: 'b' }), /home folder/)
  } finally {
    t.done()
  }
})

test('worker names are the title in lowercase words, made unique', () => {
  assert.equal(workerSlug('Dark theme: settings!', new Set()), 'dark-theme-settings')
  assert.equal(workerSlug('Dark theme', new Set(['dark-theme', 'dark-theme-2'])), 'dark-theme-3')
  assert.equal(workerSlug('!!!', new Set()), 'worker')
})

test('fleet keeps jobs and the ack cursor in its folder, and says when it is not a worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'limeade-test-fleet-'))
  const fleet = async (...args: string[]) => (await run(FLEET, args, { env: { ...process.env, FLEET_HOME: dir, FLEET_SLUG: '' } })).stdout
  try {
    assert.match(await fleet('status', 'done', 'x'), /not a fleet session/)
    assert.equal(await fleet('task', 'add', 'Dark theme', 'running', 'dark-theme'), 'task 1 added\n')
    await fleet('task', 'add', 'Second')
    await fleet('task', 'set', '2', 'state=waiting', 'note=asked about colours')
    assert.match(await fleet('task', 'list'), /#1 running Dark theme \| session: dark-theme[\s\S]*#2 waiting Second \| session: - \| asked about colours/)
    assert.equal(await fleet('ack', '7'), 'acked through 7\n')
    assert.equal(readFileSync(join(dir, 'cursor'), 'utf8'), '7\n')
    await assert.rejects(fleet('status', 'bogus', 'x'), /state must be one of/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a worker the Assistant starts shows on Workers, not in the Chat list; his own chats still do", async () => {
  const t = setup(async (req) => ({ text: req.env?.FLEET_SLUG ? 'on it' : 'ok', sessionId: 's' }))
  try {
    const told: unknown[] = []
    t.c.on('chat', (e) => told.push(e))
    const mine = await t.c.create({})
    const w = await t.workers.start({ persona: 'developer', title: 'Explain the timeline', folder: '/h/dev', brief: 'explain it' })
    await idle(t.c, w.chatId)
    await t.c.update(w.chatId, { mode: 'plan' })
    assert.deepEqual(t.c.list().map((x) => x.id), [mine.id])
    assert.deepEqual(told.map((e: any) => e.id), [mine.id]) // the open Chat list is never told of it either
    assert.deepEqual((await t.workers.list()).map((x) => x.id), ['explain-the-timeline'])
    // Its conversation stays reachable from the worker.
    const detail = await t.workers.get('explain-the-timeline')
    assert.equal(detail?.chatId, w.chatId)
    assert.deepEqual(t.c.get(w.chatId).messages.map((m) => [m.role, m.text]), [['user', 'explain it'], ['assistant', 'on it']])
  } finally {
    t.done()
  }
})
