import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Conversations, RESTARTED, WORKER_NOTE, assistantNote, freshStart, type FleetNotes } from '../src/app/conversations.ts'
import type { Chat } from '../src/domain/chat.ts'
import type { FleetMode } from '../src/domain/fleet.ts'
import type { ChatStore, Notice, NoticeLog, OneShot, TurnEngine, TurnRequest, TurnResult } from '../src/ports.ts'

/** A server with its own fleet scripts, as the homelab hub is set up. */
const SCRIPTS: FleetNotes = { kind: 'scripts', fleet: '~/bin/fleet', fleetDir: '~/.claude/fleet', handoff: '~/.claude/handoffs/assistant.md' }

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

/** Replies with a scripted function; records every request. */
class FakeEngine implements TurnEngine {
  calls: TurnRequest[] = []
  reply: (req: TurnRequest) => Promise<TurnResult>
  constructor(reply: (req: TurnRequest) => Promise<TurnResult>) {
    this.reply = reply
  }
  run(req: TurnRequest) {
    this.calls.push(req)
    return this.reply(req)
  }
}

class MemInbox {
  items: import('../src/domain/inbox.ts').InboxItem[] = []
  all() { return this.items }
  async put(i: import('../src/domain/inbox.ts').InboxItem) { this.items = [...this.items.filter((x) => x.id !== i.id), i] }
  async remove(id: string) { this.items = this.items.filter((x) => x.id !== id) }
}

/** Home is /h; ~/dev and ~/dev/app exist; ~/link escapes. */
const fakeFolders = {
  home: '/h',
  resolve: async (p: string) => ({ '~/dev': '/h/dev', '/h/dev': '/h/dev', '~/dev/app': '/h/dev/app', '/h/dev/app': '/h/dev/app' } as Record<string, string>)[p] ?? null,
  list: async () => [],
  search: async () => [],
}

function setup(opts: { claude?: FakeEngine; local?: FakeEngine; codex?: FakeEngine; codexLocal?: FakeEngine; mode?: FleetMode; events?: string[]; titler?: { claude: OneShot; local: OneShot }; fleetNotes?: FleetNotes | null } = {}) {
  const store = new MemStore()
  const inbox = new MemInbox()
  const notices = new MemNotices()
  const fleetState = { mode: opts.mode ?? 'claude-app', lastWake: 0, cursor: 0 }
  const claude = opts.claude ?? new FakeEngine(async (r) => ({ text: `claude: ${r.prompt}`, sessionId: 'sess-1' }))
  const local = opts.local ?? new FakeEngine(async (r) => ({ text: `local: ${r.prompt}`, sessionId: null }))
  const c = new Conversations({
    store,
    notices,
    engines: { claude, local, ...(opts.codex ? { codex: opts.codex } : {}), ...(opts.codexLocal ? { codexLocal: opts.codexLocal } : {}) },
    fleet: {
      lines: async () => opts.events ?? [],
      cursor: async () => fleetState.cursor,
      lastWake: async () => fleetState.lastWake,
      setLastWake: async (s) => { fleetState.lastWake = s },
    },
    fleetMode: { get: async () => fleetState.mode as FleetMode, set: async (m) => { fleetState.mode = m } },
    claudeVersions: { get: () => ({}), set: async () => {} },
    defaultChatModel: 'local:llama3.1-8b',
    inbox,
    folders: fakeFolders,
    defaultFolder: '/h/dev',
    ...(opts.titler ? { titler: opts.titler } : {}),
    fleetNotes: opts.fleetNotes === undefined ? SCRIPTS : opts.fleetNotes,
  })
  return { c, store, notices, claude, local, fleetState, inbox }
}

const idle = (c: Conversations, id: string) =>
  new Promise<void>((resolve) => {
    const check = () => (c.get(id).busy ? setTimeout(check, 5) : resolve())
    check()
  })

test('a local chat sends the history and gets a title from the first message', async () => {
  const { c, local } = setup()
  const chat = await c.create({})
  await c.send(chat.id, 'Quick dinner idea?')
  await idle(c, chat.id)
  await c.send(chat.id, 'Something else')
  await idle(c, chat.id)
  const got = c.get(chat.id)
  assert.equal(got.title, 'Quick dinner idea?')
  assert.deepEqual(got.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(local.calls[1]!.history.length, 2) // first question + answer, not the new message
  assert.equal(local.calls[1]!.prompt, 'Something else')
})

test('a Claude chat resumes its session and switches model on request', async () => {
  const { c, claude } = setup()
  const chat = await c.create({ model: 'claude:sonnet', effort: 'high' })
  await c.send(chat.id, 'one')
  await idle(c, chat.id)
  await c.send(chat.id, 'two')
  await idle(c, chat.id)
  assert.equal(claude.calls[0]!.sessionId, null)
  assert.equal(claude.calls[1]!.sessionId, 'sess-1')
  assert.equal(claude.calls[1]!.model, 'sonnet')
  assert.equal(claude.calls[1]!.effort, 'high')
  assert.equal(claude.calls[1]!.agent, undefined)
  await assert.rejects(c.update(chat.id, { model: 'claude:gpt' }), /Unknown model/)
})

test('the Assistant can run on Fable or a local model', async () => {
  const { c, claude, local } = setup()
  await c.update('assistant', { model: 'claude:claude-fable-5-2', effort: 'low' })
  await c.send('assistant', 'one')
  await idle(c, 'assistant')
  assert.equal(claude.calls[0]!.model, 'claude-fable-5-2')
  assert.equal(claude.calls[0]!.effort, 'low')
  await c.update('assistant', { model: 'local:mac-llama3.1-8b' })
  await c.send('assistant', 'two')
  await idle(c, 'assistant')
  assert.equal(local.calls.length, 1)
  assert.equal(local.calls[0]!.model, 'mac-llama3.1-8b')
  assert.equal(local.calls[0]!.history.length, 2) // for a chat-only model
  assert.equal(local.calls[0]!.sessionId, 'sess-1') // the same Claude Code session carries on
  assert.equal(local.calls[0]!.prompt, 'two') // a session already running: no fresh-start chores
  assert.equal(local.calls[0]!.agent, 'assistant')
  assert.equal(c.get('assistant').messages.at(-1)!.text, 'local: two')
  assert.equal(c.get('assistant').claudeSession, 'sess-1') // a chat-only reply (no session) keeps it
})

test('turns in one chat run one at a time, in order', async () => {
  let active = 0
  let maxActive = 0
  const local = new FakeEngine(async (r) => {
    maxActive = Math.max(maxActive, ++active)
    await new Promise((res) => setTimeout(res, 10))
    active--
    return { text: r.prompt, sessionId: null }
  })
  const { c } = setup({ local })
  const chat = await c.create({})
  await c.send(chat.id, 'a')
  await c.send(chat.id, 'b')
  await idle(c, chat.id)
  assert.equal(maxActive, 1)
  assert.deepEqual(c.get(chat.id).messages.filter((m) => m.role === 'assistant').map((m) => m.text), ['a', 'b'])
})

test('the Assistant runs as the assistant agent and starts fresh sessions with the handoff', async () => {
  const { c, claude } = setup()
  await c.send('assistant', 'hello')
  await idle(c, 'assistant')
  assert.equal(claude.calls[0]!.agent, 'assistant')
  assert.ok(claude.calls[0]!.prompt.startsWith(freshStart(SCRIPTS)))
  assert.match(claude.calls[0]!.appendSystemPrompt!, /~\/bin\/fleet ack/)
  assert.equal(c.get('assistant').mode, 'auto')
  await c.send('assistant', 'again')
  await idle(c, 'assistant')
  assert.equal(claude.calls[1]!.prompt, 'again')
  await c.newAssistantSession()
  await c.send('assistant', 'third')
  await idle(c, 'assistant')
  assert.equal(claude.calls[2]!.sessionId, null)
})

test('a lost Claude session is retried once as a new one', async () => {
  let n = 0
  const claude = new FakeEngine(async () => (++n === 1 ? { text: '', sessionId: null, error: 'gone', sessionLost: true } : { text: 'ok', sessionId: 's2' }))
  const { c } = setup({ claude })
  await c.update('assistant', { mode: 'plan' })
  await c.send('assistant', 'hi')
  await idle(c, 'assistant')
  assert.equal(claude.calls.length, 2)
  assert.equal(c.get('assistant').claudeSession, 's2')
  assert.equal(c.get('assistant').messages.at(-1)!.text, 'ok')
})

test('approvals are answered from the app and expire with their turn', async () => {
  let answered: string | undefined
  const claude = new FakeEngine((r) => new Promise((resolve) => {
    r.onEvent({ type: 'step', step: { tool: 'Bash', text: 'npm test' } })
    r.onEvent({
      type: 'approval',
      request: { tool: 'Bash', text: 'npm test', description: 'Run tests', alwaysLabel: 'npm test:*' },
      answer: (d) => {
        answered = d
        resolve({ text: 'ran it', sessionId: 's' })
      },
    })
  }))
  const { c, notices } = setup({ claude })
  await c.send('assistant', 'run the tests')
  await new Promise((r) => setTimeout(r, 5))
  const [pending] = c.pendingApprovals()
  assert.equal(pending!.text, 'npm test')
  assert.equal(notices.items[0]!.kind, 'approval')
  assert.equal(notices.items[0]!.approvalId, pending!.id)
  assert.throws(() => c.answer(pending!.id, 'maybe'), /decision/)
  c.answer(pending!.id, 'always')
  await idle(c, 'assistant')
  assert.equal(answered, 'always')
  assert.deepEqual(c.get('assistant').messages.at(-1)!.steps, [{ tool: 'Bash', text: 'npm test' }])
  assert.throws(() => c.answer(pending!.id, 'yes'), /already/)
})

test('fleet events reach the Assistant only in app mode, once, and notify', async () => {
  const events = ['7 2026-11-14T01:00:00Z cc-echo-test reported: done: echoed hi']
  const off = setup({ events })
  assert.equal(await off.c.checkFleet(), false)

  const on = setup({ events, mode: 'app' })
  on.claude.reply = async () => ({ text: '**TL;DR:** Echo test is done.', sessionId: 's' })
  assert.equal(await on.c.checkFleet(), true)
  await idle(on.c, 'assistant')
  assert.equal(await on.c.checkFleet(), false) // already woken
  assert.equal(on.fleetState.lastWake, 7)
  assert.ok(on.claude.calls[0]!.prompt.includes('[fleet event]'))
  const n = on.notices.items.at(-1)!
  assert.deepEqual([n.kind, n.title, n.body], ['done', 'Echo test is done', 'Echo test is done.'])
})

test('quiet replies and failures', async () => {
  const claude = new FakeEngine(async (r) =>
    r.prompt.includes('fail') ? { text: '', sessionId: null, error: 'boom' } : { text: '[quiet] fine', sessionId: 's' })
  const { c, notices } = setup({ claude })
  await c.send('assistant', 'x')
  await idle(c, 'assistant')
  assert.equal(notices.items.length, 0)
  assert.equal(c.get('assistant').messages.at(-1)!.text, 'fine')
  await c.send('assistant', 'please fail')
  await idle(c, 'assistant')
  assert.equal(c.get('assistant').messages.at(-1)!.role, 'error')
})

test('stop aborts the running turn', async () => {
  const local = new FakeEngine((r) => new Promise((resolve) => r.signal.addEventListener('abort', () => resolve({ text: 'part', sessionId: null }))))
  const { c } = setup({ local })
  const chat = await c.create({})
  await c.send(chat.id, 'long')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(c.stop(chat.id), true)
  await idle(c, chat.id)
  assert.equal(c.get(chat.id).messages.at(-1)!.text, 'part')
  assert.equal(c.stop(chat.id), false)
})

test('chats list newest first and the Assistant cannot be deleted', async () => {
  const { c } = setup()
  const a = await c.create({})
  await new Promise((r) => setTimeout(r, 2))
  const b = await c.create({})
  assert.deepEqual(c.list().map((x) => x.id), [b.id, a.id])
  await c.remove(a.id)
  assert.deepEqual(c.list().map((x) => x.id), [b.id])
  await assert.rejects(c.remove('assistant'), /can't be deleted/)
})

test('a failed turn always shows an error line, even after partial text', async () => {
  const claude = new FakeEngine(async () => ({ text: 'Started on it', sessionId: 's', error: 'it ran for more than 30 min, so it was stopped' }))
  const { c, notices } = setup({ claude })
  await c.send('assistant', 'long job')
  await idle(c, 'assistant')
  const msgs = c.get('assistant').messages
  assert.deepEqual(msgs.slice(-2).map((m) => [m.role, m.text]), [
    ['assistant', 'Started on it'],
    ['error', "That didn't finish: it ran for more than 30 min, so it was stopped"],
  ])
  assert.match(notices.items.at(-1)!.body, /didn't finish/)
  assert.equal(c.get('assistant').busy, false)
})

test('an engine that throws ends the turn with an error', async () => {
  const claude = new FakeEngine(async () => { throw new Error('spawn claude ENOENT') })
  const { c } = setup({ claude })
  await c.send('assistant', 'hi')
  await idle(c, 'assistant')
  assert.match(c.get('assistant').messages.at(-1)!.text, /ENOENT/)
  assert.equal(c.get('assistant').busy, false)
})

test('bell: a question goes in, buzzes as needs-you, and clears when the user replies', async () => {
  const claude = new FakeEngine(async (r) => ({ text: r.prompt.includes('ship') ? 'Notes app is done. Merge it?' : 'Merged.', sessionId: 's' }))
  const { c, inbox, notices } = setup({ claude })
  await c.send('assistant', 'ship the notes app')
  await idle(c, 'assistant')
  assert.equal(inbox.items.length, 1)
  assert.deepEqual([inbox.items[0]!.kind, inbox.items[0]!.title], ['question', 'Merge it?'])
  const n = notices.items.at(-1)!
  assert.deepEqual([n.kind, n.inboxId], ['needs', inbox.items[0]!.id])
  await c.send('assistant', 'yes')
  assert.equal(inbox.items.length, 0)
})

test('bell: [needs you] is stripped; dismiss and re-ask', async () => {
  const claude = new FakeEngine(async (r) => ({ text: r.prompt.startsWith('[from the app]') ? 'Quick reminder: the preview is up. Merge?' : '[needs you] Preview is up at https://x', sessionId: 's' }))
  const { c, inbox } = setup({ claude })
  await c.send('assistant', 'go')
  await idle(c, 'assistant')
  assert.equal(c.get('assistant').messages.at(-1)!.text, 'Preview is up at https://x')
  const [look] = inbox.items
  assert.equal(look!.kind, 'look')
  await c.reask(look!.id)
  await idle(c, 'assistant')
  assert.ok(claude.calls.at(-1)!.prompt.startsWith('[from the app] The user opened a pending item'))
  assert.equal(c.get('assistant').messages.filter((m) => m.role === 'user').length, 1) // the hidden prompt isn't a bubble
  assert.deepEqual(inbox.items.map((i) => i.kind), ['question'])
  await c.dismiss(inbox.items[0]!.id)
  assert.equal(inbox.items.length, 0)
})

test('bell: approvals come and go with their answer', async () => {
  const claude = new FakeEngine((r) => new Promise((resolve) => {
    r.onEvent({ type: 'approval', request: { tool: 'Bash', text: 'npm test', description: '', alwaysLabel: '' }, answer: () => resolve({ text: 'Ran it.', sessionId: 's' }) })
  }))
  const { c, inbox, notices } = setup({ claude })
  await c.send('assistant', 'test it')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(inbox.items.map((i) => [i.kind, i.body]), [['approval', 'npm test']])
  assert.equal(notices.items.at(-1)!.inboxId, inbox.items[0]!.id)
  await assert.rejects(c.dismiss(inbox.items[0]!.id), /Answer the approval/)
  c.answer(c.pendingApprovals()[0]!.id, 'yes')
  await idle(c, 'assistant')
  assert.equal(inbox.items.length, 0)
})

test('a plain chat runs where it was put: Claude Code works in that folder', async () => {
  const { c, claude } = setup()
  const chat = await c.create({ model: 'claude:sonnet', where: { machine: 'homelab', folder: '~/dev/app' } })
  assert.deepEqual(chat.where, { machine: 'homelab', folder: '/h/dev/app' })
  await c.send(chat.id, 'make a file')
  await idle(c, chat.id)
  assert.equal(claude.calls[0]!.cwd, '/h/dev/app')
  assert.deepEqual(c.list()[0]!.where, { machine: 'homelab', folder: '/h/dev/app' })
})

test('a new chat without a place starts in the default folder; old chats read as there too', async () => {
  const { c, store, claude } = setup()
  const chat = await c.create({ model: 'claude:opus' })
  assert.deepEqual(chat.where, { machine: 'homelab', folder: '/h/dev' })
  const old = { ...store.get(chat.id)! }
  delete old.where
  await store.save(old)
  assert.deepEqual(c.get(chat.id).where, { machine: 'homelab', folder: '/h/dev' })
  await c.send(chat.id, 'hi')
  await idle(c, chat.id)
  assert.equal(claude.calls[0]!.cwd, '/h/dev')
})

test('moving a chat to another folder starts a fresh Claude session there', async () => {
  const { c } = setup()
  const chat = await c.create({ model: 'claude:opus' })
  await c.send(chat.id, 'hi')
  await idle(c, chat.id)
  assert.equal(c.get(chat.id).claudeSession, 'sess-1')
  const same = await c.update(chat.id, { where: { machine: 'homelab', folder: '/h/dev' } })
  assert.equal(same.claudeSession, 'sess-1')
  const moved = await c.update(chat.id, { where: { machine: 'homelab', folder: '~/dev/app' } })
  assert.equal(moved.where!.folder, '/h/dev/app')
  assert.equal(moved.claudeSession, null)
})

test('places that are refused: outside home, unknown machines, and the Assistant', async () => {
  const { c } = setup()
  const chat = await c.create({})
  await assert.rejects(c.update(chat.id, { where: { machine: 'homelab', folder: '~/link' } }), /not inside your home folder/)
  await assert.rejects(c.update(chat.id, { where: { machine: 'macbook', folder: '~/dev' } }), /Unknown machine/)
  await assert.rejects(c.update(chat.id, { where: { machine: 'nas', folder: '~/dev' } }), /Unknown machine/)
  await assert.rejects(c.create({ where: { folder: '/etc' } }), /not inside your home folder/)
  await assert.rejects(c.update('assistant', { where: { folder: '~/dev' } }), /Assistant/)
})

test('a local-model chat works in its folder too, and keeps its Claude Code session', async () => {
  const local = new FakeEngine(async (r) => ({ text: `local: ${r.prompt}`, sessionId: 'local-sess' }))
  const { c } = setup({ local })
  const chat = await c.create({ where: { folder: '~/dev/app' } })
  await c.send(chat.id, 'hi')
  await idle(c, chat.id)
  assert.equal(local.calls[0]!.cwd, '/h/dev/app')
  assert.equal(c.get(chat.id).claudeSession, 'local-sess')
  await c.send(chat.id, 'again')
  await idle(c, chat.id)
  assert.equal(local.calls[1]!.sessionId, 'local-sess')
})

/** A titler that records its calls and answers with `answer` (or throws it). */
function fakeTitler(answer: string | Error) {
  const calls: { engine: string; model: string; prompt: string }[] = []
  const one = (engine: string): OneShot => ({
    complete: async (r) => {
      calls.push({ engine, model: r.model, prompt: r.prompt })
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  return { calls, titler: { claude: one('claude'), local: one('local') } }
}
const titled = (c: Conversations, id: string, title: string) =>
  new Promise<void>((resolve, reject) => {
    const until = Date.now() + 1000
    const check = () => (c.get(id).title === title ? resolve() : Date.now() > until ? reject(new Error(`title stayed ${c.get(id).title}`)) : setTimeout(check, 5))
    check()
  })

test('after the first exchange a chat gets a short title: Haiku for Claude chats, once', async () => {
  const t = fakeTitler('"Static Site With Nginx."\nextra')
  const { c } = setup({ titler: t.titler })
  const chat = await c.create({ model: 'claude:opus' })
  const seen: string[] = []
  c.on('chat', (s) => seen.push(s.title))
  await c.send(chat.id, 'how do I make nginx serve a static site from /srv on my homelab box?')
  await idle(c, chat.id)
  await titled(c, chat.id, 'Static Site With Nginx')
  assert.deepEqual(t.calls.map((x) => [x.engine, x.model]), [['claude', 'haiku']])
  assert.match(t.calls[0]!.prompt, /nginx serve a static site/)
  assert.equal(seen.at(-1), 'Static Site With Nginx')
  await c.send(chat.id, 'thanks')
  await idle(c, chat.id)
  assert.equal(t.calls.length, 1)
})

test('a local chat is titled by its own model, so it stays on his machines', async () => {
  const t = fakeTitler('Dinner Ideas')
  const { c } = setup({ titler: t.titler })
  const chat = await c.create({})
  await c.send(chat.id, 'Quick dinner idea?')
  await idle(c, chat.id)
  await titled(c, chat.id, 'Dinner Ideas')
  assert.deepEqual(t.calls.map((x) => [x.engine, x.model]), [['local', 'llama3.1-8b']])
})

test('a chat he renamed is never auto-titled, and a failed title call keeps the first words', async () => {
  const slow = fakeTitler('Ignored Title')
  const a = setup({ titler: slow.titler })
  const chat = await a.c.create({})
  await a.c.update(chat.id, { title: 'My name' })
  await a.c.send(chat.id, 'Quick dinner idea?')
  await idle(a.c, chat.id)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(a.c.get(chat.id).title, 'My name')
  assert.equal(slow.calls.length, 0)

  const broken = fakeTitler(new Error('offline'))
  const b = setup({ titler: broken.titler })
  const chat2 = await b.c.create({})
  await b.c.send(chat2.id, 'Quick dinner idea?')
  await idle(b.c, chat2.id)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(broken.calls.length, 1)
  assert.equal(b.c.get(chat2.id).title, 'Quick dinner idea?')
})

test('a turn whose final reply is empty still lands and ends the turn', async () => {
  const claude = new FakeEngine(async (r) => {
    r.onEvent({ type: 'text', text: 'Checking that:' })
    return { text: '', sessionId: 'sess-1' }
  })
  const { c, store } = setup({ claude })
  const messages: string[] = []
  c.on('message', (e) => messages.push(e.message.role))
  await c.send('assistant', 'are the other models ready')
  await idle(c, 'assistant')
  const got = c.get('assistant')
  assert.deepEqual(got.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(got.busy, false)
  assert.equal(store.get('assistant')!.turnRunning, undefined)
  assert.deepEqual(messages, ['user', 'assistant'])
})

test('a hub stopping mid-turn keeps a chat-only turn\'s interim text and says it was cut off; queued turns wait for the next hub', async () => {
  const claude = new FakeEngine((r) => new Promise((resolve) => {
    r.onEvent({ type: 'text', text: 'Both Mac models are in. Checking the GPU:' })
    r.signal.addEventListener('abort', () => resolve({ text: 'Both Mac models are in. Checking the GPU:', sessionId: 'sess-1' }))
  }))
  const { c, store } = setup({ claude })
  await c.send('assistant', 'are the other models ready')
  while (!claude.calls.length) await new Promise((r) => setTimeout(r, 5))
  assert.ok(store.get('assistant')!.turnRunning)
  await c.send('assistant', 'and the GPU?') // queued behind it: kept for the next hub
  await c.close()
  const msgs = c.get('assistant').messages
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'user', 'assistant', 'error'])
  assert.equal(msgs[2]!.text, 'Both Mac models are in. Checking the GPU:')
  assert.equal(msgs[3]!.text, RESTARTED)
  assert.equal(claude.calls.length, 1)
  assert.equal(store.get('assistant')!.turnRunning, undefined)
  assert.deepEqual(store.get('assistant')!.queuedTurns?.map((q) => q.prompt), ['and the GPU?'])
})

/** Runs on in a "keeper" that outlives the hub; reattach() finishes it. */
class KeptEngine extends FakeEngine {
  finish!: (r: TurnResult) => void
  reattached: string[] = []
  constructor() {
    super((r) => !r.prompt.includes('restart') ? Promise.resolve({ text: `ok: ${r.prompt}`, sessionId: 'sess-1' }) : new Promise((resolve) => {
      r.onStart?.('turn-1')
      r.onEvent({ type: 'text', text: 'Shipped. Restarting the hub' })
      this.finish = resolve
    }))
  }
  async reattach(handle: string, r: TurnRequest) {
    this.reattached.push(handle)
    if (handle !== 'turn-1') return null
    r.onEvent({ type: 'resumed', text: 'Shipped. Restarting the hub', steps: [{ tool: 'Bash', text: 'systemctl --user restart agent-hub' }] })
    r.onEvent({ type: 'text', text: ' now. Done.' })
    return { text: 'Shipped. Restarting the hub now. Done.', sessionId: 'sess-1' }
  }
}

const hubWith = (store: MemStore, claude: TurnEngine, notices = new MemNotices()) => new Conversations({
  store, notices, engines: { claude, local: new FakeEngine(async () => ({ text: '', sessionId: null })) },
  fleet: { lines: async () => [], cursor: async () => 0, lastWake: async () => 0, setLastWake: async () => {} },
  fleetMode: { get: async () => 'claude-app', set: async () => {} },
  claudeVersions: { get: () => ({}), set: async () => {} },
  defaultChatModel: 'local:llama3.1-8b',
})

test('a Claude Code turn outlives a hub restart: the next hub lands its reply, no red line', async () => {
  const before = new KeptEngine()
  const { c, store } = setup({ claude: before })
  await c.send('assistant', 'ship it and restart the hub')
  while (!store.get('assistant')?.liveTurn) await new Promise((r) => setTimeout(r, 5))
  await c.send('assistant', 'then check the logs') // queued behind it
  const live = store.get('assistant')!.liveTurn!
  assert.equal(live.handle, 'turn-1')
  await c.close()
  // The old hub said nothing more; the turn is still marked running for the next one.
  assert.deepEqual(c.get('assistant').messages.map((m) => m.role), ['user', 'user'])
  assert.ok(store.get('assistant')!.turnRunning)

  const after = new KeptEngine()
  const notices = new MemNotices()
  const events: [string, any][] = []
  const c2 = hubWith(store, after, notices)
  for (const name of ['live', 'delta', 'message', 'busy']) c2.on(name, (e) => events.push([name, e]))
  assert.equal(c2.get('assistant').busy, true)
  await new Promise((r) => setTimeout(r, 20))
  await idle(c2, 'assistant')
  const msgs = c2.get('assistant').messages
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [
    ['user', 'ship it and restart the hub'],
    ['user', 'then check the logs'],
    ['assistant', 'Shipped. Restarting the hub now. Done.'],
    ['assistant', 'ok: then check the logs'],
  ])
  assert.equal(msgs[2]!.id, live.replyId) // the same bubble the app was streaming
  assert.equal(msgs[2]!.steps?.[0]?.tool, 'Bash')
  assert.ok(!msgs.some((m) => m.role === 'error'))
  assert.equal(after.reattached[0], 'turn-1')
  // The queued message ran after it, on the new hub.
  assert.equal(after.calls.at(-1)!.prompt, 'then check the logs')
  assert.equal(store.get('assistant')!.turnRunning, undefined)
  assert.equal(store.get('assistant')!.liveTurn, undefined)
  assert.deepEqual(store.get('assistant')!.queuedTurns, [])
  const deltas = events.filter(([n]) => n === 'delta').map(([, e]) => [e.text, e.at])
  assert.deepEqual(deltas.slice(0, 1), [[' now. Done.', 'Shipped. Restarting the hub'.length]])
  const liveEv = events.find(([n]) => n === 'live')![1]
  assert.deepEqual([liveEv.messageId, liveEv.text], [live.replyId, 'Shipped. Restarting the hub'])
  assert.equal(notices.items[0]?.body.startsWith('Shipped'), true)
})

test('a kept turn that is gone after the restart (the box went down) is said out loud', async () => {
  const { store } = setup()
  const at = '2026-11-16T02:56:01.000Z'
  store.chats.set('assistant', {
    id: 'assistant', kind: 'assistant', title: 'Assistant', model: 'claude:opus', effort: 'medium', mode: 'auto',
    claudeSession: 's', createdAt: at, updatedAt: at, turnRunning: at,
    liveTurn: { engine: 'claude', handle: 'gone', replyId: 'r1', source: 'chat', model: 'claude:opus' },
    messages: [{ id: 'u1', at, role: 'user', source: 'chat', text: 'are the other models ready' }],
  })
  const c = hubWith(store, new KeptEngine())
  while (store.get('assistant')!.turnRunning) await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(c.get('assistant').messages.map((m) => [m.role, m.text]), [['user', 'are the other models ready'], ['error', RESTARTED]])
})

test('a turn the hub died in the middle of is said out loud after the restart', async () => {
  const { store } = setup()
  const at = '2026-11-16T02:56:01.000Z'
  store.chats.set('assistant', {
    id: 'assistant', kind: 'assistant', title: 'Assistant', model: 'claude:opus', effort: 'medium', mode: 'auto',
    claudeSession: 's', createdAt: at, updatedAt: at, turnRunning: at,
    messages: [{ id: 'u1', at, role: 'user', source: 'chat', text: 'are the other models ready' }],
  })
  const c = new Conversations({
    store, notices: new MemNotices(), engines: { claude: new FakeEngine(async () => ({ text: '', sessionId: null })), local: new FakeEngine(async () => ({ text: '', sessionId: null })) },
    fleet: { lines: async () => [], cursor: async () => 0, lastWake: async () => 0, setLastWake: async () => {} },
    fleetMode: { get: async () => 'claude-app', set: async () => {} },
    claudeVersions: { get: () => ({}), set: async () => {} },
    defaultChatModel: 'local:llama3.1-8b',
  })
  while (store.get('assistant')!.turnRunning) await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(c.get('assistant').messages.map((m) => [m.role, m.text]), [['user', 'are the other models ready'], ['error', RESTARTED]])
})

test('reading a chat mid-turn includes what the turn has said so far', async () => {
  let finish!: (r: TurnResult) => void
  const claude = new FakeEngine((r) => new Promise((resolve) => {
    r.onEvent({ type: 'text', text: 'Checking ' })
    r.onEvent({ type: 'text', text: 'the logs' })
    r.onEvent({ type: 'step', step: { tool: 'Bash', text: 'journalctl' } })
    finish = resolve
  }))
  const { c } = setup({ claude })
  await c.send('assistant', 'check the logs')
  while (!claude.calls.length) await new Promise((r) => setTimeout(r, 5))
  const mid = c.get('assistant')
  assert.equal(mid.live?.text, 'Checking the logs')
  assert.equal(mid.live?.steps.length, 1)
  finish({ text: 'Checking the logs: all fine', sessionId: 's' })
  await idle(c, 'assistant')
  assert.equal(c.get('assistant').live, undefined)
})

test('a chat on Codex runs its own models in Codex and local models in Codex too', async () => {
  const codex = new FakeEngine(async (r) => ({ text: `codex: ${r.prompt}`, sessionId: 'thread-1' }))
  const codexLocal = new FakeEngine(async (r) => ({ text: `codex local: ${r.prompt}`, sessionId: 'thread-1' }))
  const { c, claude, local } = setup({ codex, codexLocal })
  const chat = await c.create({ agent: 'codex', model: 'codex:gpt-6.1-sol', effort: 'high' })
  assert.equal(chat.agent, 'codex')
  assert.equal(c.list()[0]!.agent, 'codex')
  await c.send(chat.id, 'one')
  await idle(c, chat.id)
  assert.equal(codex.calls[0]!.model, 'gpt-6.1-sol')
  assert.equal(codex.calls[0]!.effort, 'high')
  assert.equal(codex.calls[0]!.cwd, '/h/dev')
  assert.equal(c.get(chat.id).claudeSession, 'thread-1')
  assert.equal(c.get(chat.id).sessionAgent, 'codex')
  await c.update(chat.id, { model: 'local:mac-gemma4-26b' })
  await c.send(chat.id, 'two')
  await idle(c, chat.id)
  assert.equal(codexLocal.calls[0]!.model, 'mac-gemma4-26b')
  assert.equal(codexLocal.calls[0]!.sessionId, 'thread-1') // the same Codex session carries on
  assert.equal(codexLocal.calls[0]!.prompt, 'two')
  assert.equal(claude.calls.length + local.calls.length, 0)
})

test('switching a chat to the other agent starts its own session, told what was said so far', async () => {
  const codex = new FakeEngine(async (r) => ({ text: `codex: ${r.prompt.slice(-3)}`, sessionId: 'thread-1' }))
  const { c, claude } = setup({ codex, codexLocal: codex })
  const chat = await c.create({ model: 'claude:opus' })
  await c.send(chat.id, 'one')
  await idle(c, chat.id)
  await c.update(chat.id, { agent: 'codex', model: 'local:mac-gemma4-26b' })
  await c.send(chat.id, 'two')
  await idle(c, chat.id)
  const first = codex.calls[0]!
  assert.equal(first.sessionId, null) // Claude's session is no use to Codex
  assert.match(first.prompt, /^\(This conversation was with Claude Code until now/)
  assert.match(first.prompt, /User: one\n\nClaude Code: claude: one/)
  assert.match(first.prompt, /The new message:\)\n\ntwo$/)
  await c.send(chat.id, 'six')
  await idle(c, chat.id)
  assert.equal(codex.calls[1]!.sessionId, 'thread-1')
  assert.equal(codex.calls[1]!.prompt, 'six')
  // And back: Claude starts fresh too, told about the Codex part.
  await c.update(chat.id, { agent: 'claude', model: 'claude:sonnet' })
  assert.equal(c.get(chat.id).agent, undefined)
  await c.send(chat.id, 'ten')
  await idle(c, chat.id)
  assert.equal(claude.calls[1]!.sessionId, null)
  assert.match(claude.calls[1]!.prompt, /^\(This conversation was with Codex until now/)
  assert.equal(c.get(chat.id).sessionAgent, undefined)
  assert.equal(c.get(chat.id).claudeSession, 'sess-1')
})

test('without the fleet scripts the Assistant is told nothing about fleets or handoffs', async () => {
  const { c, claude } = setup({ fleetNotes: null })
  await c.send('assistant', 'hello')
  await idle(c, 'assistant')
  assert.equal(claude.calls[0]!.prompt, 'hello')
  assert.doesNotMatch(claude.calls[0]!.appendSystemPrompt!, /fleet|handoff|wrap-up|homelab/i)
  assert.match(claude.calls[0]!.appendSystemPrompt!, /\[quiet\].*\[needs you\]/)
})

test('the Assistant switches to Codex as the same agent, told the recent conversation, and back', async () => {
  const codex = new FakeEngine(async (r) => ({ text: '[needs you] **TL;DR:** look at this', sessionId: 'thread-1' }))
  const { c, claude, inbox } = setup({ codex, codexLocal: codex })
  await c.send('assistant', 'one')
  await idle(c, 'assistant')
  const switched = await c.update('assistant', { agent: 'codex', model: 'local:mac-gemma4-26b' })
  assert.equal(switched.agent, 'codex')
  await c.send('assistant', 'two')
  await idle(c, 'assistant')
  const first = codex.calls[0]!
  assert.equal(first.agent, 'assistant')
  assert.equal(first.sessionId, null)
  assert.equal(first.appendSystemPrompt, claude.calls[0]!.appendSystemPrompt)
  assert.ok(first.prompt.startsWith(freshStart(SCRIPTS)))
  assert.match(first.prompt, /This conversation was with Claude Code until now[\s\S]*User: one[\s\S]*two$/)
  // Its reply lands like Claude's: [needs you] goes to the bell.
  assert.equal(c.get('assistant').messages.at(-1)!.text, '**TL;DR:** look at this')
  assert.equal(inbox.items.length, 1)
  await c.send('assistant', 'three')
  await idle(c, 'assistant')
  assert.equal(codex.calls[1]!.sessionId, 'thread-1')
  assert.equal(codex.calls[1]!.prompt, 'three')
  await c.update('assistant', { agent: 'claude', model: 'claude:opus' })
  await c.send('assistant', 'four')
  await idle(c, 'assistant')
  assert.equal(claude.calls[1]!.sessionId, null)
  assert.match(claude.calls[1]!.prompt, /This conversation was with Codex until now/)
  await assert.rejects(c.update('assistant', { where: { folder: '~/dev/app' } }), /Assistant always works/)
})

test('Codex only where the hub has it, and only on models it runs', async () => {
  const { c } = setup()
  await assert.rejects(c.create({ agent: 'codex', model: 'local:m' }), /Codex isn't set up/)
  const codex = new FakeEngine(async () => ({ text: 'x', sessionId: 't' }))
  const { c: c2 } = setup({ codex, codexLocal: codex })
  await assert.rejects(c2.create({ agent: 'codex', model: 'claude:opus' }), /Codex can't run that model/)
  await assert.rejects(c2.create({ agent: 'robot' }), /agent must be/)
  const chat = await c2.create({ model: 'claude:opus' })
  await assert.rejects(c2.update(chat.id, { agent: 'codex' }), /Codex can't run that model/)
  await assert.rejects(c2.update(chat.id, { model: 'codex:gpt-6.1-sol' }), /Claude Code can't run that model/)
  assert.equal((await c2.update(chat.id, { agent: 'codex', model: 'codex:gpt-6-luna' })).agent, 'codex')
  await assert.rejects(c2.update('assistant', { agent: 'codex' }), /Codex can't run that model/)
})

test('a Codex turn that outlives a hub restart is picked up by Codex, in its own session', async () => {
  const { c, store } = setup()
  const chat = await c.create({ agent: undefined, model: 'local:m' })
  // As an earlier hub left it: a Codex turn running in its keeper.
  const saved = store.get(chat.id)!
  store.chats.set(chat.id, { ...saved, agent: 'codex', model: 'codex:gpt-6.1-sol', claudeSession: 'thread-9', sessionAgent: 'codex', turnRunning: 'x',
    liveTurn: { engine: 'codex', handle: 'codex-1', replyId: 'r1', source: 'chat', model: 'codex:gpt-6.1-sol' } })
  const picked: TurnRequest[] = []
  const codex: TurnEngine = { run: async () => ({ text: '', sessionId: null }), reattach: async (_h, r) => { picked.push(r); return { text: 'done after restart', sessionId: 'thread-9' } } }
  const c2 = new Conversations({
    store, notices: new MemNotices(), engines: { claude: new FakeEngine(async () => ({ text: '', sessionId: null })), local: new FakeEngine(async () => ({ text: '', sessionId: null })), codex },
    fleet: { lines: async () => [], cursor: async () => 0, lastWake: async () => 0, setLastWake: async () => {} },
    fleetMode: { get: async () => 'claude-app' as FleetMode, set: async () => {} },
    claudeVersions: { get: () => ({}), set: async () => {} }, defaultChatModel: 'local:m',
  })
  await idle(c2, chat.id)
  assert.equal(picked[0]!.sessionId, 'thread-9')
  assert.equal(c2.get(chat.id).messages.at(-1)!.text, 'done after restart')
  assert.equal(c2.get(chat.id).sessionAgent, 'codex')
})

test('with fleet scripts the Assistant is told exactly what it was told before workers were built in', () => {
  assert.equal(freshStart(SCRIPTS), '(New assistant conversation, reached through Limeade. Before anything else, run ' +
    '~/bin/fleet digest and read ~/.claude/handoffs/assistant.md to pick up where the last assistant left off.)\n\n')
  const note = assistantNote(SCRIPTS)
  assert.ok(note.endsWith([
    'Fleet events arrive as messages starting with "[fleet event]": handle them exactly as you would a fleet-rewake wake-up, then ~/bin/fleet ack.',
    'Do not write your session id to ~/.claude/fleet/assistant-session; the hub delivers fleet events to you.',
    'When your context gets large, hand off yourself: run the wrap-up skill, tell the user in one line, then after your reply schedule POST /chats/assistant/new-session (see assistant.md); never ask them to start it.',
  ].join(' ')))
})

test('with built-in workers the Assistant is told the bundled fleet command, and events say fleet ack', async () => {
  const { c, claude } = setup({ fleetNotes: { kind: 'builtin' }, mode: 'app', events: ['1 2026-11-17T10:00:00Z dark-theme reported: done: shipped'] })
  await c.checkFleet()
  await idle(c, 'assistant')
  const call = claude.calls[0]!
  assert.match(call.appendSystemPrompt!, /fleet start <agent> "<Title>" <folder> <brief-file>/)
  // Handed-off work goes to visible workers, not subagents the Workers page can't show (issue #6).
  assert.match(call.appendSystemPrompt!, /your own subagents \(helpers you start inside your turn\) never do\. So any job you hand off goes to a worker/)
  assert.match(call.appendSystemPrompt!, /only after `fleet start` succeeded/)
  assert.doesNotMatch(call.appendSystemPrompt!, /~\/bin|\.claude|homelab/i)
  assert.match(call.prompt, /^\(New assistant conversation[^)]*fleet digest/)
  assert.match(call.prompt, /\[fleet event\] Fleet events \(handle each, then fleet ack\):\n1 2026-11-17T10:00:00Z dark-theme reported: done: shipped$/)
})

test('a worker chat runs as its persona in its folder, told how to report, with its name in the environment', async () => {
  const { c, claude } = setup({ fleetNotes: { kind: 'builtin' } })
  await c.update('assistant', { model: 'claude:sonnet' })
  const w = await c.createWorker({ title: 'Dark theme', worker: { slug: 'dark-theme', persona: 'developer' }, folder: '/h/dev/app', brief: 'Add a dark theme' })
  await idle(c, w.id)
  const call = claude.calls[0]!
  assert.equal(call.agent, 'developer')
  assert.equal(call.model, 'sonnet')
  assert.equal(call.mode, 'auto')
  assert.equal(call.cwd, '/h/dev/app')
  assert.equal(call.prompt, 'Add a dark theme')
  assert.equal(call.appendSystemPrompt, WORKER_NOTE)
  assert.deepEqual(call.env, { FLEET_SLUG: 'dark-theme' })
  assert.equal(c.get(w.id).title, 'Dark theme')
  assert.equal(c.get(w.id).renamed, true)
})
