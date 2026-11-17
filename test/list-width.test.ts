import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const lw = createRequire(import.meta.url)('../public/list-width.js')

test('list width: kept within 240px and half the window', () => {
  assert.equal(lw.fit(100, 1680, 64), 240)
  assert.equal(lw.fit(500, 1680, 64), 500)
  assert.equal(lw.fit(1200, 1680, 64), 840)
  assert.equal(lw.fit(Infinity, 1680, 64), 840)
})

test('list width: the chat keeps at least 560px on a narrow wide window', () => {
  assert.equal(lw.maxFor(1024, 64), 400)
  assert.equal(lw.fit(500, 1024, 64), 400)
  assert.equal(lw.fit(500, 1024, 248), 240) // sidebar unfolded: the list gives way, but not under its minimum
})

test('list width: a kept value is read back, junk falls back to the default', () => {
  assert.equal(lw.parse('333'), 333)
  assert.equal(lw.parse(null), lw.DEFAULT)
  assert.equal(lw.parse(''), lw.DEFAULT)
  assert.equal(lw.parse('wide'), lw.DEFAULT)
  assert.equal(lw.parse('-5'), lw.DEFAULT)
})

test('list width: arrow keys step it, Shift steps further, Home and End go to the ends', () => {
  assert.equal(lw.afterKey(400, 'ArrowRight', false), 416)
  assert.equal(lw.afterKey(400, 'ArrowLeft', true), 336)
  assert.equal(lw.fit(lw.afterKey(400, 'Home', false), 1680, 64), 240)
  assert.equal(lw.fit(lw.afterKey(400, 'End', false), 1680, 64), 840)
  assert.equal(lw.afterKey(400, 'Enter', false), null)
})
