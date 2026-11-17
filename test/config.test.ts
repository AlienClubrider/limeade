import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEnvFiles, envFilesOf, hubConfig } from '../src/config.ts'
import { ollamaUrl } from '../src/domain/local-models.ts'

const HOME = '/home/someone'
const APP = '/apps/limeade'

test('a fresh computer: its own folders, the browser here signs in, Ollama on localhost, built-in workers', () => {
  const c = hubConfig({}, HOME, APP)
  assert.equal(c.port, 8797)
  assert.equal(c.stateDir, `${HOME}/.local/state/limeade`)
  assert.equal(c.configDir, `${HOME}/.config/limeade`)
  assert.equal(c.uploadsDir, `${HOME}/.local/state/limeade/uploads`)
  assert.equal(c.workDir, HOME)
  assert.equal(c.machineName, 'This computer')
  assert.equal(c.access, null)
  assert.equal(c.defaultChatModel, '')
  assert.match(c.pushSubject, /^mailto:/)
  assert.deepEqual(c.localModels, { kind: 'ollama', url: 'http://localhost:11434' })
  assert.deepEqual(c.fleet, { kind: 'builtin', dir: `${HOME}/.local/state/limeade/fleet` })
  assert.equal(c.webDir, `${APP}/public`)
})

test('settings come from the environment, with ~ for home', () => {
  const c = hubConfig({ PORT: '9001', OLLAMA_URL: 'http://mac.local:11434', WORK_DIR: '~/code', TRUSTED_HOSTS: 'Mac.tail1.ts.net, other' }, HOME, APP)
  assert.equal(c.port, 9001)
  assert.equal(c.workDir, `${HOME}/code`)
  assert.deepEqual(c.localModels, { kind: 'ollama', url: 'http://mac.local:11434' })
  assert.deepEqual(c.trustedHosts, ['mac.tail1.ts.net', 'other'])
})

test('an Ollama address is cleaned up or refused', () => {
  assert.equal(ollamaUrl('localhost:11434'), 'http://localhost:11434')
  assert.equal(ollamaUrl(' http://10.0.0.5:11434/ '), 'http://10.0.0.5:11434')
  assert.equal(ollamaUrl('https://ollama.example.com/base/'), 'https://ollama.example.com/base')
  assert.equal(ollamaUrl('http://user:pw@host:1'), null)
  assert.equal(ollamaUrl('http://host:1/?x=1'), null)
  assert.equal(ollamaUrl(''), null)
  assert.equal(ollamaUrl(42), null)
})

test('the settings files Node was started with, in order, in either spelling', () => {
  assert.deepEqual(envFilesOf(['--env-file-if-exists=/c/limeade.env']), ['/c/limeade.env'])
  assert.deepEqual(envFilesOf(['--env-file', '/a.env', '--no-warnings', '--env-file-if-exists=/b.env']), ['/a.env', '/b.env'])
  assert.deepEqual(envFilesOf(['--no-warnings']), [])
})

test("limeade.env wins over a stale key the service inherited; names it doesn't set stay as they were", () => {
  const env: Record<string, string | undefined> = { PORTKEY_OPENAI_API_KEY: 'old', HOME: '/h', PATH: '/bin' }
  const files: Record<string, string> = { '/c/limeade.env': '# settings\nPORTKEY_OPENAI_API_KEY=new\nCODEX_API_KEY="new"\n' }
  applyEnvFiles(env, ['--env-file-if-exists=/c/limeade.env', '--env-file-if-exists=/c/missing.env'], (p) => files[p] ?? null)
  assert.deepEqual(env, { PORTKEY_OPENAI_API_KEY: 'new', CODEX_API_KEY: 'new', HOME: '/h', PATH: '/bin' })
})

test('started the way the service starts it, the file beats an inherited variable (Node alone keeps the inherited one)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'limeade-env-'))
  try {
    const file = join(dir, 'limeade.env')
    writeFileSync(file, 'PROVIDER_KEY=from-file\n')
    const config = new URL('../src/config.ts', import.meta.url).href
    const code = `const before = process.env.PROVIDER_KEY
const { applyEnvFiles } = await import(${JSON.stringify(config)})
const { readFileSync } = await import('node:fs')
applyEnvFiles(process.env, process.execArgv, (p) => readFileSync(p, 'utf8'))
console.log(before + ' ' + process.env.PROVIDER_KEY)`
    const r = spawnSync(process.execPath, [`--env-file-if-exists=${file}`, '--input-type=module', '-e', code], { env: { ...process.env, PROVIDER_KEY: 'inherited' }, encoding: 'utf8' })
    assert.equal(r.stderr.trim(), '')
    assert.equal(r.stdout.trim(), 'inherited from-file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
