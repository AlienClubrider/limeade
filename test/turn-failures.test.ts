import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeCli } from '../src/adapters/claude-cli.ts'

const turnsDir = () => mkdtempSync(join(tmpdir(), 'turns-'))

test('a turn that never answers is stopped and says so', async () => {
  const cli = new ClaudeCli({
    bin: fileURLToPath(new URL('./fixtures/stuck-claude.sh', import.meta.url)),
    cwd: '/tmp',
    turnsDir: turnsDir(),
    turnTimeoutMs: 200,
    killGraceMs: 100,
  })
  const started = Date.now()
  const r = await cli.run({
    prompt: 'hi', history: [], model: 'opus', effort: 'low', mode: 'auto', sessionId: null,
    signal: new AbortController().signal, onEvent: () => {},
  })
  assert.ok(Date.now() - started < 3000)
  assert.match(r.error ?? '', /more than 0 min|stopped/)
})

test('a missing CLI is an error, not a hang', async () => {
  const cli = new ClaudeCli({ bin: '/nonexistent/claude', cwd: '/tmp', turnsDir: turnsDir(), turnTimeoutMs: 5000 })
  const r = await cli.run({
    prompt: 'hi', history: [], model: 'opus', effort: 'low', mode: 'auto', sessionId: null,
    signal: new AbortController().signal, onEvent: () => {},
  })
  assert.ok(r.error)
})
