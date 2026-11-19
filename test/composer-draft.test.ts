// The composer's send rules (issue #13): Shift+Enter is a new line, and a failed send puts the text back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isWebFile } from '../src/adapters/web-files.ts'
const draft = createRequire(import.meta.url)('../public/composer-draft.js')

const key = (k: string, shiftKey = false) => ({ key: k, shiftKey })

test('composer: plain Enter sends on a computer; Shift+Enter is a new line', () => {
  assert.equal(draft.sendsOnEnter(key('Enter'), true), true)
  assert.equal(draft.sendsOnEnter(key('Enter', true), true), false)
  assert.equal(draft.sendsOnEnter(key('a'), true), false)
})

test('composer: Enter on a phone is a new line (the arrow sends)', () => {
  assert.equal(draft.sendsOnEnter(key('Enter'), false), false)
})

test('composer: a failed send puts the text back, ahead of anything typed meanwhile', () => {
  assert.equal(draft.afterFailedSend('fix the tests', ''), 'fix the tests')
  assert.equal(draft.afterFailedSend('fix the tests', '  \n'), 'fix the tests')
  assert.equal(draft.afterFailedSend('fix the tests', 'and the docs'), 'fix the tests\nand the docs')
})

test('composer: the send code clears the box as it sends, not only when it is unchanged', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const send = app.slice(app.indexOf('const send = async () =>'), app.indexOf('function attachSheet'))
  assert.ok(send.indexOf("ta.value = ''") < send.indexOf('await onSend'), 'the box empties before the send goes')
  assert.doesNotMatch(send, /ta\.value\.trim\(\) === text/)
})

test('composer: every script the page loads is served', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  for (const [, src] of html.matchAll(/<script src="([^"?]+)/g)) assert.ok(isWebFile(src!), src)
})
