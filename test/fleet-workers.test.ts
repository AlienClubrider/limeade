import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetWorkers } from '../src/adapters/fleet-workers.ts'

test('a registered worker without a tmux session is not listed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-workers-'))
  try {
    await mkdir(join(dir, 'fleet', 'status'), { recursive: true })
    const slug = `cc-test-gone-${process.pid}`
    await writeFile(join(dir, 'agent-sessions.tsv'), `u1\tsession_1\tdeveloper\tGone\t/tmp\t${slug}\n`)
    await writeFile(join(dir, 'fleet', 'status', `${slug}.status`), '2026-11-14T22:00:00Z needs-decision: PR ready?\n')
    const workers = new FleetWorkers({ claudeDir: dir, forgetBin: '/bin/false', machine: 'Test' })
    assert.deepEqual(await workers.list(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
