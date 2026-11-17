import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubConfig } from '../src/config.ts'
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
