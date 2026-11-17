import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpReplyReader, approvalFor, optionFor } from '../src/adapters/acp-turns.ts'
import { CodexAcp, codexConfig, codexMode, codexTool, type OllamaModel } from '../src/adapters/codex-acp.ts'
import type { EngineEvent, TurnRequest } from '../src/ports.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const codexIn = (turnsDir: string, log: string, local?: (name: string) => Promise<OllamaModel | null>, persona?: (id: string) => Promise<string | null>) =>
  new CodexAcp({ ...(persona ? { persona } : {}), adapter: { bin: process.execPath, args: [FAKE] }, codexBin: '/bin/true', cwd: '/tmp', turnsDir, turnTimeoutMs: 60_000, killGraceMs: 500, env: { FAKE_ACP_LOG: log }, keys: () => ({ DD_API_KEY: 'k1' }), addDirs: ['/up'], ...(local ? { local } : {}) })
const req = (events: EngineEvent[], over: Partial<TurnRequest> = {}): TurnRequest => ({
  prompt: 'hi', history: [], model: 'gpt-6.1-sol', effort: 'high', mode: 'acceptEdits', sessionId: null,
  signal: new AbortController().signal, onEvent: (e) => events.push(e), ...over,
})
const sent = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const tmp = () => mkdtempSync(join(tmpdir(), 'cxs2-test-'))
const codexTools = { tool: codexTool, noise: (u: any) => typeof u?.messageId !== 'string' && /^Warning: /.test(u?.content?.text ?? '') }

test('the mode chip maps to Codex modes, with plan as read-only plus its plan mode', () => {
  assert.deepEqual(codexMode('ask'), { modeId: 'read-only', config: [{ configId: 'collaboration_mode', value: 'default' }] })
  assert.equal(codexMode('acceptEdits').modeId, 'workspace-write')
  assert.equal(codexMode('auto').modeId, 'agent')
  assert.deepEqual(codexMode('plan'), { modeId: 'read-only', config: [{ configId: 'collaboration_mode', value: 'plan' }] })
})

test("Codex's config: its own model and effort, or a local model on its Ollama machine", () => {
  assert.deepEqual(codexConfig({ model: 'gpt-6-astra', effort: 'low' }, null), { model: 'gpt-6-astra', model_reasoning_effort: 'low' })
  const local = codexConfig({ model: 'mac-gemma4-26b', effort: 'low' }, { url: 'http://10.0.0.2:11434/', tag: 'gemma4:26b', machine: 'MacBook Pro' }) as any
  assert.equal(local.model, 'gemma4:26b')
  assert.equal(local.model_provider, 'limeade-ollama')
  assert.deepEqual(local.model_providers['limeade-ollama'], { name: 'Ollama on MacBook Pro', base_url: 'http://10.0.0.2:11434/v1', wire_api: 'responses' })
})

test("Codex's tool calls read as the app's steps (as Codex 2.7's adapter sends them)", () => {
  assert.deepEqual(codexTool({ kind: 'execute', title: 'ls', rawInput: { command: 'ls -la', cwd: '/w' } }), { name: 'Bash', input: { command: 'ls -la' } })
  assert.deepEqual(codexTool({ kind: 'execute', rawInput: { command: "/bin/bash -lc 'echo it'\\''s > /h/a.txt'" } }), { name: 'Bash', input: { command: "echo it's > /h/a.txt" } })
  assert.deepEqual(codexTool({ kind: 'read', title: "Read file '/w/a.txt'", locations: [{ path: '/w/a.txt' }] }), { name: 'Read', input: { file_path: '/w/a.txt' } })
  assert.deepEqual(codexTool({ kind: 'read', title: "List files in 'src'" }), { name: 'Glob', input: { pattern: 'src' } })
  assert.deepEqual(codexTool({ kind: 'search', title: 'Search for TODO' }), { name: 'Grep', input: { pattern: 'Search for TODO' } })
  assert.deepEqual(codexTool({ kind: 'edit', title: 'Editing files', content: [{ type: 'diff', path: '/w/b.ts', oldText: 'a', newText: 'b' }] }), { name: 'Edit', input: { file_path: '/w/b.ts' } })
  assert.deepEqual(codexTool({ kind: 'fetch', title: 'Searching the web', rawInput: { query: 'limes' } }), { name: 'WebSearch', input: { query: 'limes' } })
  assert.equal(codexTool({ kind: 'think', title: 'Compact conversation' }), null)
  assert.deepEqual(codexTool({ kind: 'other', title: 'github/search_issues', rawInput: { q: 'x' } }), { name: 'github/search_issues', input: { q: 'x' } })
})

test("Codex's updates: its warnings aren't the reply, thinking isn't a step, commands are", () => {
  const r = new AcpReplyReader({ alias: 'x', reportModel: false, agent: codexTools })
  const ev = [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Warning: Model metadata for `gemma4:26b` not found.\n\n' } },
    { sessionUpdate: 'tool_call', toolCallId: 'c0', kind: 'think', title: 'Compact conversation', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c0', status: 'completed' },
    { sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'exec_command', kind: 'read', title: "Read file '/w/note.txt'", status: 'in_progress', locations: [{ path: '/w/note.txt' }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { exit_code: 0 } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'It says ' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'hi.' } },
  ].flatMap((u) => r.read(u))
  assert.deepEqual(ev.filter((e) => e.type === 'step').map((e: any) => e.step.label), ['Reading note.txt'])
  assert.equal(r.text, 'It says hi.')
})

test("a Codex permission request becomes the approval card, and decisions pick Codex's options", () => {
  // As Codex asked to write outside the workspace (captured from codex-acp 2.7.0).
  const params = {
    toolCall: { toolCallId: 'call_a', title: 'echo lime > /h/out.txt', rawInput: { command: 'echo lime > /h/out.txt', cwd: '/w' }, kind: 'execute', status: 'pending' },
    options: [
      { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
      { optionId: 'accept_execpolicy_amendment', name: "Yes, and don't ask again for commands that start with `echo lime`", kind: 'allow_always' },
      { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
    ],
  }
  const a = approvalFor(params, codexTool)
  assert.equal(a.tool, 'Bash')
  assert.equal(a.text, 'echo lime > /h/out.txt')
  assert.equal(a.alwaysLabel, 'commands that start with `echo lime`')
  assert.equal(optionFor('yes', params.options), 'allow_once')
  assert.equal(optionFor('always', params.options), 'accept_execpolicy_amendment')
  assert.equal(optionFor('no', params.options), 'cancel')
})

test("a Codex turn sends Codex's config, mode and folders, streams, and answers approvals", async () => {
  const dir = tmp()
  const log = join(dir, 'fake.log')
  const events: EngineEvent[] = []
  let handle = ''
  const r = await codexIn(dir, log).run(req(events, {
    prompt: 'ask', cwd: dir, onStart: (h) => (handle = h),
    onEvent: (e) => { events.push(e); if (e.type === 'approval') e.answer('yes') },
  }))
  assert.equal(r.error, undefined)
  assert.equal(r.text, 'one two three four five six (allow-once)')
  assert.equal(r.sessionId, 'fake-acp-sess')
  assert.match(handle, /^codex-[0-9a-f-]{36}$/)
  const approval = events.find((e) => e.type === 'approval') as any
  assert.equal(approval.request.tool, 'Bash')
  assert.equal(approval.request.text, 'ls')
  const msgs = sent(log)
  assert.deepEqual(JSON.parse(msgs.find((m) => m.env)!.env.CODEX_CONFIG), { model: 'gpt-6.1-sol', model_reasoning_effort: 'high' })
  assert.equal(msgs.find((m) => m.env)!.env.CODEX_PATH, '/bin/true')
  // Keys MCP servers need reach the agent as environment variables.
  assert.equal(msgs.find((m) => m.env)!.env.DD_API_KEY, 'k1')
  const opened = msgs.find((m) => m.method === 'session/new')!
  assert.deepEqual(opened.params, { cwd: dir, mcpServers: [], additionalDirectories: ['/up'] })
  assert.equal(msgs.find((m) => m.method === 'session/set_mode')!.params.modeId, 'workspace-write')
  assert.deepEqual(msgs.find((m) => m.method === 'session/set_config_option')!.params, { sessionId: 'fake-acp-sess', configId: 'collaboration_mode', value: 'default' })
  // A Claude handle is not Codex's to pick up.
  assert.equal(await codexIn(dir, log).reattach('acp-00000000-0000-0000-0000-000000000000', req([])), null)
})

test('a local model in Codex runs on its Ollama machine; one no machine has fails plainly', async () => {
  const dir = tmp()
  const log = join(dir, 'fake.log')
  const local = async (name: string) => (name === 'mac-gemma4-26b' ? { url: 'http://mac:11434', tag: 'gemma4:26b', machine: 'MacBook Pro' } : null)
  const r = await codexIn(dir, log, local).run(req([], { model: 'mac-gemma4-26b', sessionId: 'thread-1' }))
  assert.equal(r.error, undefined)
  const cfg = JSON.parse(sent(log).find((m) => m.env)!.env.CODEX_CONFIG)
  assert.equal(cfg.model, 'gemma4:26b')
  assert.equal(cfg.model_providers['limeade-ollama'].base_url, 'http://mac:11434/v1')
  assert.equal(sent(log).find((m) => m.method === 'session/resume')!.params.sessionId, 'thread-1')
  const before = readdirSync(dir).length
  const gone = await codexIn(dir, log, local).run(req([], { model: 'mac-nope' }))
  assert.match(gone.error!, /mac-nope isn't on any of your machines now/)
  assert.ok(readdirSync(dir).length <= before) // no turn was started for it
})

test("the Assistant on Codex runs with its persona and the hub's note as added instructions", async () => {
  const dir = tmp()
  const log = join(dir, 'fake.log')
  const persona = async (id: string) => (id === 'assistant' ? 'You are the assistant.' : null)
  const r = await codexIn(dir, log, undefined, persona).run(req([], { agent: 'assistant', appendSystemPrompt: 'Start with a TL;DR.' }))
  assert.equal(r.error, undefined)
  const opened = sent(log).find((m) => m.method === 'session/new')!
  assert.deepEqual(opened.params.systemPrompt, { mode: 'append', content: [{ type: 'text', text: 'You are the assistant.\n\nStart with a TL;DR.' }] })
  // A persona Codex doesn't have fails plainly, before any turn starts.
  const before = readdirSync(dir).length
  const none = await codexIn(dir, log, undefined, persona).run(req([], { agent: 'nobody' }))
  assert.match(none.error!, /Codex has no nobody agent on this box/)
  assert.ok(readdirSync(dir).length <= before)
})
