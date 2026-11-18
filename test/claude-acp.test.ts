import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpReplyReader, ClaudeAcp, acpMode, acpPrompt, approvalFor, optionFor, sessionParams } from '../src/adapters/claude-acp.ts'
import { ChosenEngine } from '../src/adapters/engine-choice.ts'
import type { EngineEvent, Steer, TurnEngine, TurnRequest, TurnResult } from '../src/ports.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const HUB = fileURLToPath(new URL('./fixtures/hub-acp.ts', import.meta.url))

const acpIn = (turnsDir: string, log?: string) =>
  new ClaudeAcp({ adapter: { bin: process.execPath, args: [FAKE] }, claudeBin: '/bin/true', cwd: '/tmp', turnsDir, turnTimeoutMs: 60_000, killGraceMs: 500, env: log ? { FAKE_ACP_LOG: log } : {} })
const req = (events: EngineEvent[], over: Partial<TurnRequest> = {}): TurnRequest => ({
  prompt: 'hi', history: [], model: 'opus', effort: 'low', mode: 'ask', sessionId: null,
  signal: new AbortController().signal, onEvent: (e) => events.push(e), ...over,
})
const sent = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const texts = (events: EngineEvent[]) => events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')

test('the app mode chip maps to ACP session modes', () => {
  assert.equal(acpMode('ask'), 'default')
  assert.equal(acpMode('acceptEdits'), 'acceptEdits')
  assert.equal(acpMode('auto'), 'auto')
  assert.equal(acpMode('plan'), 'plan')
})

test('session params carry model, effort, agent, the Assistant note and the uploads folder', () => {
  const p = sessionParams({ model: 'opus', effort: 'high', agent: 'assistant', appendSystemPrompt: 'Note.' }, { cwd: '/home/x/dev', addDirs: ['/up'] }) as any
  assert.equal(p.cwd, '/home/x/dev')
  assert.deepEqual(p.additionalDirectories, ['/up'])
  assert.deepEqual(p._meta.claudeCode.options, { model: 'opus', effort: 'high', promptSuggestions: false, agent: 'assistant' })
  assert.deepEqual(p._meta.systemPrompt, { append: 'Note.' })
  const plain = sessionParams({ model: 'haiku', effort: 'low', cwd: '/w' }, { cwd: '/home/x/dev' }) as any
  assert.equal(plain.cwd, '/w')
  assert.equal(plain._meta.systemPrompt, undefined)
  assert.equal(plain._meta.claudeCode.options.agent, undefined)
  assert.equal(plain._meta.claudeCode.options.disallowedTools, undefined) // Chat and workers keep subagents
  const assistant = sessionParams({ model: 'opus', effort: 'high', agent: 'assistant', noSubagents: true }, { cwd: '/w' }) as any
  assert.deepEqual(assistant._meta.claudeCode.options.disallowedTools, ['Agent', 'Task'])
})

test('photos go as ACP image blocks before the text', () => {
  assert.deepEqual(acpPrompt('hi'), [{ type: 'text', text: 'hi' }])
  assert.deepEqual(acpPrompt([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }, { type: 'text', text: 'see' }]), [
    { type: 'image', mimeType: 'image/png', data: 'AA==' },
    { type: 'text', text: 'see' },
  ])
})

test('a permission request becomes the approval card, and decisions pick the offered option', () => {
  const options = [
    { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'allow-with-updates', name: "Yes, and don't ask again for npm run test:* commands", kind: 'allow_always' },
    { optionId: 'reject', name: 'No', kind: 'reject_once' },
  ]
  const a = approvalFor({ toolCall: { name: 'Bash', title: 'npm test', rawInput: { command: 'npm test', description: 'Run the tests' }, _meta: { claudeCode: { toolName: 'Bash' } } }, options })
  assert.equal(a.tool, 'Bash')
  assert.equal(a.text, 'npm test')
  assert.equal(a.description, 'Run the tests')
  assert.equal(a.alwaysLabel, 'npm run test:* commands')
  assert.equal(optionFor('yes', options), 'allow-once')
  assert.equal(optionFor('always', options), 'allow-with-updates')
  assert.equal(optionFor('no', options), 'reject')
  assert.equal(optionFor('always', [options[0]!]), 'allow-once')
  assert.equal(approvalFor({ toolCall: { rawInput: {} }, options: [options[0]] }).alwaysLabel, '')
  const dirs = [{ optionId: 'x', name: 'Yes, and allow access to work/ and echo done * commands', kind: 'allow_always' }]
  assert.equal(approvalFor({ toolCall: { name: 'Bash', rawInput: { command: 'echo done' } }, options: dirs }).alwaysLabel, 'access to work/ and echo done * commands')
  // Leaving plan mode: the "always" choices switch modes (and may clear context), so they're not offered.
  const plan = [
    { optionId: 'exit-plan-clear-auto', name: 'Yes, clear context (6% used) and use auto mode', kind: 'allow_always' },
    { optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
    { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
  ]
  assert.equal(approvalFor({ toolCall: { name: 'ExitPlanMode', rawInput: { plan: 'p' }, _meta: { claudeCode: { toolName: 'ExitPlanMode' } } }, options: plan }).alwaysLabel, '')
  assert.equal(optionFor('yes', plan), 'exit-plan-default')
})

test('updates become text with a break between messages, one step per tool call, and the model once', () => {
  const r = new AcpReplyReader({ alias: 'opus', reportModel: true })
  const ev = [
    { sessionUpdate: 'usage_update', _meta: { '_claude/model': 'claude-opus-5-5' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: 'Looking.' } },
    { sessionUpdate: 'tool_call', toolCallId: 't1', rawInput: {}, status: 'pending', _meta: { claudeCode: { toolName: 'Bash' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: { command: 'ls' }, _meta: { claudeCode: { toolName: 'Bash' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: { command: 'ls', description: 'x' }, _meta: { claudeCode: { toolName: 'Bash' } } },
    { sessionUpdate: 'tool_call', toolCallId: 's1', rawInput: { command: 'pwd' }, _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'agent1' } } },
    { sessionUpdate: 'usage_update', _meta: { '_claude/model': 'claude-opus-5-5' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'b', content: { type: 'text', text: 'Done' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'b', content: { type: 'text', text: '.' } },
  ].flatMap((u) => r.read(u))
  assert.deepEqual(ev.filter((e) => e.type === 'model'), [{ type: 'model', alias: 'opus', modelId: 'claude-opus-5-5' }])
  const steps = ev.filter((e) => e.type === 'step')
  assert.equal(steps.length, 1)
  assert.deepEqual((steps[0] as any).step.text, 'ls')
  assert.equal(r.text, 'Looking.\n\nDone.')
  assert.equal(r.last, 'Done.')
  // A local model's name says nothing about Claude versions.
  assert.deepEqual(new AcpReplyReader({ alias: 'x', reportModel: false }).read({ sessionUpdate: 'usage_update', _meta: { '_claude/model': 'x' } }), [])
})

test('a plain run streams, sends model and mode, answers and tidies its folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const log = join(dir, 'fake.log')
  const events: EngineEvent[] = []
  let handle = ''
  const r = await acpIn(dir, log).run(req(events, { onStart: (h) => (handle = h) }))
  assert.equal(r.error, undefined)
  assert.equal(r.text, 'one two three four five six')
  assert.equal(r.sessionId, 'fake-acp-sess')
  assert.ok(handle.startsWith('acp-'))
  assert.equal(texts(events), 'one two three four five six')
  assert.ok(events.some((e) => e.type === 'model' && e.modelId === 'claude-fake-1'))
  const got = sent(log)
  assert.equal(got.find((m) => m.method === 'session/new').params._meta.claudeCode.options.model, 'opus')
  assert.equal(got.find((m) => m.method === 'session/set_mode').params.modeId, 'default')
  assert.equal(got.find((m) => m.method === 'session/prompt').params.prompt[0].text, 'hi')
  for (let i = 0; i < 100 && existsSync(join(dir, handle)); i++) await new Promise((res) => setTimeout(res, 50))
  assert.equal(existsSync(join(dir, handle)), false)
})

test('a chat with a session resumes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const log = join(dir, 'fake.log')
  const r = await acpIn(dir, log).run(req([], { sessionId: 'abc' }))
  assert.equal(r.sessionId, 'abc')
  assert.equal(sent(log).find((m) => m.method === 'session/resume').params.sessionId, 'abc')
})

test('a session that no longer exists is reported lost, so the hub starts a fresh one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const r = await acpIn(dir).run(req([], { sessionId: 'gone' }))
  assert.equal(r.sessionLost, true)
  assert.equal(r.sessionId, null)
  assert.match(r.error ?? '', /not found/)
})

test('an approval: yes reaches the adapter and the turn carries on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const events: EngineEvent[] = []
  const r = await acpIn(dir).run(req(events, {
    prompt: 'please ask first',
    onEvent: (e) => {
      events.push(e)
      if (e.type === 'approval') e.answer('always')
    },
  }))
  const a = events.find((e) => e.type === 'approval')
  assert.ok(a && a.type === 'approval' && a.request.text === 'ls' && a.request.alwaysLabel === 'ls commands')
  assert.ok(events.some((e) => e.type === 'step'))
  assert.equal(r.text, 'one two three four five six (allow-with-updates)')
})

test('no with a reason refuses the tool and tells Claude why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const r = await acpIn(dir).run(req([], {
    prompt: 'ask',
    onEvent: (e) => {
      if (e.type === 'approval') e.answer('no', 'use dir instead')
    },
  }))
  assert.equal(r.text, 'one two three four five six (reject) [use dir instead]')
})

test('a plain no stops the turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const r = await acpIn(dir).run(req([], {
    prompt: 'ask',
    onEvent: (e) => {
      if (e.type === 'approval') e.answer('no')
    },
  }))
  assert.equal(r.error, undefined)
  assert.equal(r.text, 'one two three ')
})

test('stop cancels the turn and keeps what it said', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const ctl = new AbortController()
  const events: EngineEvent[] = []
  const r = await acpIn(dir).run(req(events, {
    signal: ctl.signal,
    onEvent: (e) => {
      events.push(e)
      if (e.type === 'text' && e.text === 'two ') ctl.abort()
    },
  }))
  assert.equal(r.error, undefined)
  assert.ok(r.text.startsWith('one two'))
  assert.ok(!r.text.includes('six'))
})

/** Starts a turn in another hub process, waits until `until` says so, then kills that hub outright. */
async function hubDiesMidTurn(turnsDir: string, prompt: string, until: (seen: any[]) => boolean): Promise<string> {
  const hub = spawn(process.execPath, [HUB, turnsDir, prompt], { stdio: ['ignore', 'pipe', 'inherit'] })
  const seen: any[] = []
  await new Promise<void>((resolve, reject) => {
    createInterface({ input: hub.stdout! }).on('line', (l) => {
      seen.push(JSON.parse(l))
      if (until(seen)) resolve()
    })
    hub.on('exit', () => reject(new Error('the hub ended on its own')))
  })
  hub.removeAllListeners('exit')
  hub.kill('SIGKILL')
  assert.ok(!seen.some((s) => s.result), 'the first hub never saw the end')
  return seen.find((s) => s.handle)!.handle
}

test('an ACP turn carries on when the hub dies mid-reply, and the next hub gets the whole reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const handle = await hubDiesMidTurn(dir, 'hi', (s) => s.filter((x) => x.text).length >= 2)
  const events: EngineEvent[] = []
  const r = await acpIn(dir).reattach(handle, req(events))
  assert.ok(r)
  assert.equal(r.error, undefined)
  assert.equal(r.text, 'one two three four five six')
  assert.equal(r.sessionId, 'fake-acp-sess')
  const resumed = events.find((e) => e.type === 'resumed')
  assert.ok(resumed && resumed.type === 'resumed' && resumed.text.startsWith('one two '))
  assert.equal((resumed as { text: string }).text + texts(events), 'one two three four five six')
  for (let i = 0; i < 100 && readdirSync(dir).length; i++) await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual(readdirSync(dir), [])
})

test('a permission prompt open when the hub died is asked again, and the answer reaches the adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const handle = await hubDiesMidTurn(dir, 'please ask first', (s) => s.some((x) => x.approval))
  const events: EngineEvent[] = []
  const r = await acpIn(dir).reattach(handle, req(events, {
    onEvent: (e) => {
      events.push(e)
      if (e.type === 'approval') e.answer('yes')
    },
  }))
  assert.equal(events.filter((e) => e.type === 'approval').length, 1)
  assert.equal(r?.text, 'one two three four five six (allow-once)')
})

test('a kept turn is picked up by the engine that started it, whatever the setting says now', async () => {
  const calls: string[] = []
  const fake = (name: string): TurnEngine => ({
    run: async () => (calls.push(`${name}.run`), { text: '', sessionId: null }) as TurnResult,
    reattach: async () => (calls.push(`${name}.reattach`), null),
  })
  let on = false
  const e = new ChosenEngine({ cli: fake('cli'), acp: fake('acp'), useAcp: () => on })
  await e.run(req([]))
  on = true
  await e.run(req([]))
  await e.reattach('0b6c2b1e-5a1f-4d6e-9d0c-3f1a2b3c4d5e', req([]))
  on = false
  await e.reattach('acp-0b6c2b1e-5a1f-4d6e-9d0c-3f1a2b3c4d5e', req([]))
  assert.deepEqual(calls, ['cli.run', 'acp.run', 'cli.reattach', 'acp.reattach'])
  assert.equal(await acpIn(mkdtempSync(join(tmpdir(), 'turns-'))).reattach('../../etc', req([])), null)
})

/** Runs a turn, sending `steers` in (one after another) once it has said "two ". */
async function steeredRun(engine: TurnEngine, steers: string[], over: Partial<TurnRequest> = {}) {
  const events: EngineEvent[] = []
  const took: Promise<boolean>[] = []
  let steer: Steer | undefined
  const r = await engine.run(req(events, {
    ...over,
    onSteerable: (s) => (steer = s),
    onEvent: (e) => {
      events.push(e)
      if (e.type === 'text' && e.text === 'two ') for (const p of steers) took.push(steer!({ id: randomUUID(), prompt: p }))
    },
  }))
  return { r, events, took: await Promise.all(took), steer: steer! }
}

test('a message sent mid-turn is steered into the running ACP turn, and several go in order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const log = join(dir, 'fake.log')
  const { r, took } = await steeredRun(acpIn(dir, log), ['also otters', 'and penguins'])
  assert.deepEqual(took, [true, true])
  assert.equal(r.text, 'one two three four five six [also otters; and penguins]')
  const steering = sent(log).filter((m) => m.method === '_session/steering')
  assert.deepEqual(steering.map((m) => m.params.prompt), [[{ type: 'text', text: 'also otters' }], [{ type: 'text', text: 'and penguins' }]])
  // The hub keeps the message if no turn is running, rather than the adapter starting one on its own.
  assert.equal(steering[0].params._meta.steering.idleBehavior, 'promptRequired')
  assert.equal(steering[0].params.sessionId, 'fake-acp-sess')
})

test('a steer the ACP adapter refuses (its turn had ended) is reported not taken, so the hub queues it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const engine = new ClaudeAcp({ adapter: { bin: process.execPath, args: [FAKE] }, claudeBin: '/bin/true', cwd: '/tmp', turnsDir: dir, turnTimeoutMs: 60_000, killGraceMs: 500, env: { FAKE_STEER: 'refuse' } })
  const { r, took, steer } = await steeredRun(engine, ['one more'])
  assert.deepEqual(took, [false])
  assert.equal(r.text, 'one two three four five six')
  // And after the turn, nothing goes in.
  assert.equal(await steer({ id: randomUUID(), prompt: 'later' }), false)
})
