// When the Assistant's chat counts as in front of the user, so its replies don't buzz (GitHub issue #1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { assistantInFront } = createRequire(import.meta.url)('../public/on-screen.js')

const base = { visible: true, tab: 'assistant', pages: [] as { full: boolean }[], wide: true, drawerOpen: false }

test('on screen: the Assistant with nothing over it is in front', () => {
  assert.equal(assistantInFront(base), true)
  assert.equal(assistantInFront({ ...base, wide: false }), true)
})

test('on screen: Settings (a full page) covers the Assistant on a wide window', () => {
  assert.equal(assistantInFront({ ...base, pages: [{ full: true }] }), false)
  assert.equal(assistantInFront({ ...base, pages: [{ full: false }, { full: true }] }), false)
})

test('on screen: a side panel on a wide window leaves the Assistant showing; on a phone any page covers it', () => {
  assert.equal(assistantInFront({ ...base, pages: [{ full: false }] }), true)
  assert.equal(assistantInFront({ ...base, wide: false, pages: [{ full: false }] }), false)
})

test('on screen: hidden, another tab or the open drawer is not in front', () => {
  assert.equal(assistantInFront({ ...base, visible: false }), false)
  assert.equal(assistantInFront({ ...base, tab: 'chat' }), false)
  assert.equal(assistantInFront({ ...base, wide: false, drawerOpen: true }), false)
})
