import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const clip = createRequire(import.meta.url)('../public/clip.js')

const NOW = new Date(2026, 10, 16, 14, 3, 9)
/** A DataTransfer as browsers hand it to paste and drop handlers. */
const transfer = (types: string[], files: File[], items?: object[]) => ({ types, files, items: items ?? files.map((f) => ({ kind: 'file', getAsFile: () => f })) })

test('paste: a macOS screenshot attaches as pasted-image-<time>.png, same bytes', async () => {
  const shot = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' })
  const [f] = clip.filesFrom(transfer(['Files'], [shot]), NOW)
  assert.equal(f.name, 'pasted-image-20261116-140309.png')
  assert.equal(f.type, 'image/png')
  assert.deepEqual(new Uint8Array(await f.arrayBuffer()), new Uint8Array([137, 80, 78, 71]))
})

test('paste: an image copied from a browser (only in items, no name) attaches', () => {
  const img = new File(['x'], '', { type: 'image/jpeg' })
  const files = clip.filesFrom({ types: ['text/html', 'Files'], files: [], items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => img }] }, NOW)
  assert.deepEqual(files.map((f: File) => f.name), ['pasted-image-20261116-140309.jpg'])
})

test('paste: plain text and Office text-with-picture stay text; named files keep their names', () => {
  assert.deepEqual(clip.filesFrom(transfer(['text/plain'], [], [{ kind: 'string' }]), NOW), [])
  const picture = new File(['x'], 'image.png', { type: 'image/png' })
  assert.deepEqual(clip.filesFrom(transfer(['text/plain', 'text/rtf', 'Files'], [picture]), NOW), [])
  const pdf = new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' })
  const photo = new File(['x'], 'IMG_0042.HEIC', { type: 'image/heic' })
  assert.deepEqual(clip.filesFrom(transfer(['Files'], [pdf, photo]), NOW).map((f: File) => f.name), ['invoice.pdf', 'IMG_0042.HEIC'])
  const two = [new File(['a'], 'image.png', { type: 'image/png' }), new File(['b'], 'image.png', { type: 'image/png' })]
  assert.deepEqual(clip.filesFrom(transfer(['Files'], two), NOW).map((f: File) => f.name), ['pasted-image-20261116-140309.png', 'pasted-image-20261116-140309-2.png'])
  assert.equal(clip.dragHasFiles({ types: ['Files'] }), true)
  assert.equal(clip.dragHasFiles({ types: ['text/plain'] }), false)
})

test('the page can load clip.js, plain or content-hashed', async () => {
  const { isWebFile } = await import('../src/adapters/web-files.ts')
  assert.equal(isWebFile('/clip.js'), true)
  assert.equal(isWebFile('/clip.0123456789.js'), true)
})
