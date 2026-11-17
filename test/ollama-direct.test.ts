import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OllamaDirect } from '../src/adapters/ollama-direct.ts'
import { endpointEnv } from '../src/adapters/claude-cli.ts'
import { entryFor } from '../src/domain/local-models.ts'

const machine = { id: 'local', label: 'This computer', short: 'computer', url: 'http://localhost:11434', prefix: '', fitsGb: 40, maxGb: 48 }
const gemma = entryFor(machine, { tag: 'gemma4:26b', size: 17e9, parameterSize: '26B', capabilities: ['completion', 'tools'] }, undefined, 'gemma4-26b')
const llama = entryFor(machine, { tag: 'llama3.1:8b', size: 5e9, parameterSize: '8B', capabilities: ['completion'] }, undefined, 'llama3.1-8b')

test('straight to Ollama: the picker, tool verdicts, a plain chat by tag, and Claude Code pointed at Ollama by tag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'limeade-test-ollama-'))
  const seen: { url: string; body: any }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.endsWith('/api/tags')) return new Response('{"models":[]}')
    const sse = 'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\ndata: {"choices":[{"delta":{"content":"there"}}]}\n\ndata: [DONE]\n\n'
    return new Response(sse)
  }) as typeof globalThis.fetch
  try {
    const o = new OllamaDirect({ file: join(dir, 'models.json'), fetch })
    assert.equal(await o.read(), null)
    await o.write([gemma, llama])
    const groups = await o.groups()
    assert.deepEqual(groups.map((g) => [g.title, g.online, g.models.map((m) => [m.id, m.label, !!m.chatOnly])]), [
      ['This computer', true, [['local:gemma4-26b', 'Gemma 4 26B', false], ['local:llama3.1-8b', 'Llama 3.1 8B', true]]],
    ])
    assert.equal(await o.usesTools('llama3.1-8b'), false)
    assert.deepEqual(await o.ollamaModel('gemma4-26b'), { url: 'http://localhost:11434', tag: 'gemma4:26b', machine: 'This computer' })
    const texts: string[] = []
    const r = await o.run({ prompt: 'hello', history: [], model: 'llama3.1-8b', effort: 'low', mode: 'auto', sessionId: null, signal: new AbortController().signal, onEvent: (e) => e.type === 'text' && texts.push(e.text) })
    assert.equal(r.text, 'Hi there')
    const chat = seen.find((s) => s.url.endsWith('/v1/chat/completions'))!
    assert.equal(chat.url, 'http://localhost:11434/v1/chat/completions')
    assert.equal(chat.body.model, 'llama3.1:8b')
    // A new hub reads the list it kept.
    assert.equal((await new OllamaDirect({ file: join(dir, 'models.json'), fetch }).read())?.length, 2)
    const env = endpointEnv('gemma4-26b', { url: 'http://localhost:11434', key: null, model: (n) => o.tagFor(n) })
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:11434')
    assert.equal(env.ANTHROPIC_MODEL, 'gemma4:26b')
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'gemma4:26b')
    assert.match((await o.run({ prompt: 'x', history: [], model: 'gone-1b', effort: 'low', mode: 'auto', sessionId: null, signal: new AbortController().signal, onEvent: () => {} })).error!, /isn't on this computer's Ollama/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Claude Code on Ollama is started with the tag, by the CLI and through ACP alike', async () => {
  const { claudeArgs, endpointModel } = await import('../src/adapters/claude-cli.ts')
  const { sessionParams } = await import('../src/adapters/claude-acp.ts')
  const ep = { url: 'http://localhost:11434', key: null, model: (n: string) => (n === 'gemma4-26b' ? 'gemma4:26b' : n) }
  const req = { model: endpointModel('gemma4-26b', ep), effort: 'low' as const, mode: 'auto' as const, sessionId: null }
  const args = claudeArgs(req, [])
  assert.equal(args[args.indexOf('--model') + 1], 'gemma4:26b')
  assert.ok(JSON.stringify(sessionParams(req, { cwd: '/w' })).includes('"model":"gemma4:26b"'))
  assert.equal(endpointModel('opus', undefined), 'opus')
})

test("a local model's turn keeps to its endpoint, whatever provider the user's Claude Code settings name", async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { ClaudeCli, endpointSettings } = await import('../src/adapters/claude-cli.ts')
  const { sessionParams } = await import('../src/adapters/claude-acp.ts')
  const ep = { url: 'http://localhost:11434', key: 'local-key', model: (n: string) => (n === 'llama3.2-1b' ? 'llama3.2:1b' : n) }

  // Claude Code applies its settings files' env over the process env, so the endpoint goes in as settings,
  // which rank above them, with a gateway's key, headers and key script cleared.
  const s = endpointSettings('llama3.2-1b', ep)
  assert.equal(s.apiKeyHelper, '')
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'http://localhost:11434')
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'local-key')
  assert.equal(s.env.ANTHROPIC_MODEL, 'llama3.2:1b')
  for (const k of ['ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL']) assert.equal(s.env[k], '', k)
  for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) assert.equal(s.env[k], '0', k)

  // Through ACP: the same settings ride with the session's options.
  const opts = (sessionParams({ model: 'llama3.2-1b', effort: 'low' }, { cwd: '/w', endpoint: ep }) as any)._meta.claudeCode.options
  assert.equal(opts.model, 'llama3.2:1b')
  assert.deepEqual(opts.settings, s)
  assert.equal((sessionParams({ model: 'opus', effort: 'low' }, { cwd: '/w' }) as any)._meta.claudeCode.options.settings, undefined)

  // Through the CLI: a --settings file (so the key isn't on the command line); plain Claude chats get none.
  const bin = fileURLToPath(new URL('./fixtures/settings-claude.sh', import.meta.url))
  const env = { FAKE_NODE: process.execPath, ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_CUSTOM_HEADERS: 'x-gateway: 1' }
  const turn = { prompt: 'hi', history: [], model: 'llama3.2-1b', effort: 'low', mode: 'auto', sessionId: null, signal: new AbortController().signal, onEvent: () => {} } as const
  const local = new ClaudeCli({ bin, cwd: '/tmp', turnsDir: mkdtempSync(join(tmpdir(), 'turns-')), turnTimeoutMs: 10_000, env, endpoint: ep })
  const seen = JSON.parse((await local.run(turn)).text)
  assert.deepEqual(seen.settings, s)
  assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'llama3.2:1b')
  assert.ok(!seen.args.join(' ').includes('local-key'))
  const plain = new ClaudeCli({ bin, cwd: '/tmp', turnsDir: mkdtempSync(join(tmpdir(), 'turns-')), turnTimeoutMs: 10_000, env })
  const seenPlain = JSON.parse((await plain.run({ ...turn, model: 'opus' })).text)
  assert.equal(seenPlain.settings, null)
  assert.ok(!seenPlain.args.includes('--settings'))
})
