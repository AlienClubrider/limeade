import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeCli } from '../src/adapters/claude-cli.ts'
import type { EngineEvent, TurnRequest } from '../src/ports.ts'

const BIN = fileURLToPath(new URL('./fixtures/fake-claude.sh', import.meta.url))
const HUB_A = fileURLToPath(new URL('./fixtures/hub-a.ts', import.meta.url))

const cliIn = (turnsDir: string) => new ClaudeCli({ bin: BIN, cwd: '/tmp', turnsDir, turnTimeoutMs: 60_000, env: { FAKE_NODE: process.execPath } })
const req = (events: EngineEvent[], over: Partial<TurnRequest> = {}): TurnRequest => ({
  prompt: 'hi', history: [], model: 'opus', effort: 'low', mode: 'auto', sessionId: null,
  signal: new AbortController().signal, onEvent: (e) => events.push(e), ...over,
})

/** Starts a turn in another hub process, waits until `until` says so, then kills that hub outright. */
async function hubDiesMidTurn(turnsDir: string, prompt: string, until: (seen: any[]) => boolean): Promise<{ handle: string; seen: any[] }> {
  const hub = spawn(process.execPath, [HUB_A, turnsDir, BIN, prompt], { stdio: ['ignore', 'pipe', 'inherit'] })
  const seen: any[] = []
  await new Promise<void>((resolve, reject) => {
    createInterface({ input: hub.stdout! }).on('line', (l) => {
      seen.push(JSON.parse(l))
      if (until(seen)) resolve()
    })
    hub.on('exit', () => reject(new Error('hub A ended on its own')))
  })
  hub.removeAllListeners('exit')
  hub.kill('SIGKILL')
  const handle = seen.find((s) => s.handle)?.handle
  assert.ok(handle)
  return { handle, seen }
}

test('a turn carries on when the hub dies mid-reply, and the next hub gets the whole reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const { handle, seen } = await hubDiesMidTurn(dir, 'hi', (s) => s.filter((x) => x.text).length >= 2)
  assert.ok(!seen.some((s) => s.result), 'hub A never saw the end')
  const events: EngineEvent[] = []
  const r = await cliIn(dir).reattach(handle, req(events))
  assert.ok(r)
  assert.equal(r.error, undefined)
  assert.equal(r.text, 'one two three four five six')
  assert.equal(r.sessionId, 'fake-sess')
  // What it had said before the restart comes back in one piece, then the rest streams.
  const resumed = events.find((e) => e.type === 'resumed')
  assert.ok(resumed && resumed.type === 'resumed' && resumed.text.startsWith('one two '))
  const after = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')
  assert.equal((resumed as { text: string }).text + after, 'one two three four five six')
  // Tidied once the CLI has exited.
  for (let i = 0; i < 100 && readdirSync(dir).length; i++) await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual(readdirSync(dir), [])
})

test('a permission prompt open when the hub died is asked again, and the answer reaches the CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const { handle } = await hubDiesMidTurn(dir, 'please ask first', (s) => s.some((x) => x.approval))
  const events: EngineEvent[] = []
  const r = cliIn(dir).reattach(handle, req(events, {
    onEvent: (e) => {
      events.push(e)
      if (e.type === 'approval') e.answer('yes')
    },
  }))
  const result = await r
  assert.equal(events.filter((e) => e.type === 'approval').length, 1)
  assert.equal(result?.text, 'one two three four five six (allow)')
})

test('a turn that finished while no hub was running is collected by the next one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const { handle } = await hubDiesMidTurn(dir, 'hi', (s) => s.some((x) => x.text))
  await new Promise((res) => setTimeout(res, 1500))
  const events: EngineEvent[] = []
  const r = await cliIn(dir).reattach(handle, req(events))
  assert.equal(r?.text, 'one two three four five six')
  assert.equal(r?.error, undefined)
})

test('a turn whose keeper died with the box is reported lost (null), not hung', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const handle = '0b6c2b1e-5a1f-4d6e-9d0c-3f1a2b3c4d5e'
  mkdirSync(join(dir, handle))
  writeFileSync(join(dir, handle, 'started'), String(Date.now()))
  writeFileSync(join(dir, handle, 'out.jsonl'), JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'half' } } }) + '\n')
  const started = Date.now()
  assert.equal(await cliIn(dir).reattach(handle, req([])), null)
  assert.ok(Date.now() - started < 8000)
  assert.equal(await cliIn(dir).reattach('../../etc', req([])), null)
  assert.equal(await cliIn(dir).reattach('9b6c2b1e-5a1f-4d6e-9d0c-3f1a2b3c4d5e', req([])), null)
})

test('a plain run streams, answers and tidies its folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'))
  const events: EngineEvent[] = []
  let handle = ''
  const r = await cliIn(dir).run(req(events, { onStart: (h) => (handle = h) }))
  assert.equal(r.text, 'one two three four five six')
  assert.ok(handle)
  assert.equal(events.filter((e) => e.type === 'text').length, 6)
  for (let i = 0; i < 100 && existsSync(join(dir, handle)); i++) await new Promise((res) => setTimeout(res, 50))
  assert.equal(existsSync(join(dir, handle)), false)
})
