import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Conversations } from '../src/app/conversations.ts'
import { createHub } from '../src/adapters/http.ts'
import { UploadFiles } from '../src/adapters/upload-files.ts'
import { claudeArgs, userContent } from '../src/adapters/claude-cli.ts'
import {
  MAX_FILE_BYTES, attachmentIds, attachmentNote, attachmentsLabel, safeFileName, sendsInline, typeFor,
} from '../src/domain/attachments.ts'
import { summarize, type Chat } from '../src/domain/chat.ts'
import type { Notice, TurnRequest } from '../src/ports.ts'

const KEY = 'k'.repeat(40)
const tmp = () => mkdtempSync(join(tmpdir(), 'limeade-uploads-'))
async function* chunks(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p)
}

// ---------- rules ----------

test('file names stay his but can never climb out of their folder', () => {
  assert.equal(safeFileName('Invoice March.pdf'), 'Invoice March.pdf')
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('C:\\Users\\b\\photo.JPG'), 'photo.JPG')
  assert.equal(safeFileName('..hidden'), 'hidden')
  assert.equal(safeFileName('a\u0000b<c>.txt'), 'abc.txt')
  assert.equal(safeFileName(''), 'file')
  const long = safeFileName(`${'x'.repeat(300)}.xlsx`)
  assert.equal(long.length, 100)
  assert.ok(long.endsWith('.xlsx'))
})

test('types come from the extension; small photos go inline, the rest by path', () => {
  assert.equal(typeFor('a.JPG'), 'image/jpeg')
  assert.equal(typeFor('a.pdf'), 'application/pdf')
  assert.equal(typeFor('a.svg'), 'application/octet-stream')
  assert.equal(typeFor('noext'), 'application/octet-stream')
  assert.ok(sendsInline({ id: 'x', name: 'a.png', type: 'image/png', size: 1000 }))
  assert.ok(!sendsInline({ id: 'x', name: 'a.png', type: 'image/png', size: 9_000_000 }))
  assert.ok(!sendsInline({ id: 'x', name: 'a.heic', type: 'image/heic', size: 1000 }))
  assert.ok(!sendsInline({ id: 'x', name: 'a.pdf', type: 'application/pdf', size: 1000 }))
})

test('a message names at most five of our own upload ids', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  assert.deepEqual(attachmentIds(undefined), [])
  assert.deepEqual(attachmentIds([id(1), id(1)]), [id(1)])
  assert.throws(() => attachmentIds(['../x']), /upload ids/)
  assert.throws(() => attachmentIds('x'), /upload ids/)
  assert.throws(() => attachmentIds([1, 2, 3, 4, 5, 6].map(id)), /At most 5/)
})

test('the note tells the Assistant every file and where it is saved', () => {
  const note = attachmentNote([
    { id: 'a', name: 'cat.png', type: 'image/png', size: 2048, path: '/u/assistant/a/cat.png' },
    { id: 'b', name: 'q3.pdf', type: 'application/pdf', size: 3 * 1024 * 1024, path: '/u/assistant/b/q3.pdf' },
  ])
  assert.match(note, /2 files/)
  assert.match(note, /cat\.png \(image\/png, 2 KB\): \/u\/assistant\/a\/cat\.png — shown to you above/)
  assert.match(note, /q3\.pdf \(application\/pdf, 3\.0 MB\): \/u\/assistant\/b\/q3\.pdf — open it with the Read tool/)
  assert.equal(attachmentNote([]), '')
})

test('a message with only files reads sensibly in lists', () => {
  const photo = { id: 'a', name: 'a.jpg', type: 'image/jpeg', size: 1 }
  assert.equal(attachmentsLabel([photo]), 'Sent a photo')
  assert.equal(attachmentsLabel([photo, photo]), 'Sent 2 photos')
  assert.equal(attachmentsLabel([{ ...photo, name: 'q.pdf', type: 'application/pdf' }]), 'Sent q.pdf')
  const chat: Chat = {
    id: 'c', kind: 'chat', title: 't', model: 'claude:opus', effort: 'medium', mode: 'auto', claudeSession: null, createdAt: '', updatedAt: '',
    messages: [{ id: 'm', at: '', role: 'user', source: 'chat', text: '', attachments: [photo] }],
  }
  assert.equal(summarize(chat).preview, 'Sent a photo')
})

// ---------- the store ----------

test('uploads are saved privately under their chat and found again', async () => {
  const root = tmp()
  const store = new UploadFiles(root)
  const saved = await store.save('assistant', '../notes.txt', chunks('hello ', 'there'), 1000)
  assert.notEqual(saved, 'too-big')
  if (saved === 'too-big') return
  assert.equal(saved.name, 'notes.txt')
  assert.equal(saved.type, 'text/plain')
  assert.equal(saved.size, 11)
  const got = await store.get('assistant', saved.id)
  assert.equal(got?.path, join(root, 'assistant', saved.id, 'notes.txt'))
  assert.equal(readFileSync(got!.path, 'utf8'), 'hello there')
  assert.equal(statSync(got!.path).mode & 0o777, 0o600)
  assert.equal(await store.get('other', saved.id), null)
  assert.equal(await store.get('assistant', '../assistant'), null)
  await assert.rejects(store.save('../x', 'a.txt', chunks('x'), 10), /Bad chat id/)
})

test('an upload over the cap is refused and nothing is kept', async () => {
  const store = new UploadFiles(tmp())
  assert.equal(await store.save('assistant', 'big.bin', chunks('12345', '67890', 'x'), 10), 'too-big')
})

// ---------- the Claude CLI message ----------

test('photos go to Claude as image blocks, before the text and the note', async () => {
  const files = [
    { id: 'a', name: 'cat.png', type: 'image/png', size: 3, path: '/u/a/cat.png' },
    { id: 'b', name: 'q3.pdf', type: 'application/pdf', size: 3, path: '/u/b/q3.pdf' },
  ]
  const read = async (p: string) => {
    assert.equal(p, '/u/a/cat.png') // the PDF is read by Claude itself, by path
    return Buffer.from('png')
  }
  const content = await userContent('What is this?', files, read)
  assert.ok(Array.isArray(content))
  assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png').toString('base64') } })
  assert.equal(content[1]!.type, 'text')
  assert.match((content[1] as { text: string }).text, /^What is this\?\n\n\[The user attached 2 files/)
  assert.equal(await userContent('plain'), 'plain')
})

test('for a local model photos go by path only: most local models cannot see images', async () => {
  const files = [{ id: 'a', name: 'cat.png', type: 'image/png', size: 3, path: '/u/a/cat.png' }]
  const content = await userContent('What is this?', files, async () => assert.fail('nothing is read inline'), false)
  assert.ok(Array.isArray(content))
  assert.equal(content.length, 1)
  assert.match((content[0] as { text: string }).text, /\/u\/a\/cat\.png — open it with the Read tool/)
})

test('the uploads folder is readable by the CLI without asking', () => {
  const args = claudeArgs({ model: 'opus', effort: 'medium', mode: 'auto', sessionId: null }, ['/home/h/limeade-uploads'])
  assert.deepEqual(args.slice(-2), ['--add-dir', '/home/h/limeade-uploads'])
})

// ---------- conversations and HTTP ----------

async function start() {
  const chats = new Map<string, Chat>()
  const notices: Notice[] = []
  const noticeLog = {
    since: () => notices,
    append: async (n: Omit<Notice, 'seq' | 'at'>) => ({ ...n, seq: 1, at: 'now' }),
  }
  const calls: TurnRequest[] = []
  const root = tmp()
  const fleetMode = { get: async () => 'claude-app' as const, set: async () => {} }
  const conversations = new Conversations({
    store: {
      list: () => [...chats.values()],
      get: (id) => chats.get(id) ?? null,
      save: async (c) => { chats.set(c.id, c) },
      remove: async (id) => { chats.delete(id) },
    },
    notices: noticeLog,
    engines: {
      claude: { run: async (r) => { calls.push(r); return { text: 'A cat.', sessionId: 's' } } },
      local: { run: async () => ({ text: 'echo', sessionId: null }) },
    },
    fleet: { lines: async () => [], cursor: async () => 0, lastWake: async () => 0, setLastWake: async () => {} },
    fleetMode,
    claudeVersions: { get: () => ({}), set: async () => {} },
    defaultChatModel: 'local:m',
    uploads: new UploadFiles(root),
  })
  const hub = createHub({
    key: KEY, conversations, notices: noticeLog, fleetMode,
    localModels: { groups: async () => [] },
    claudeVersions: { get: () => ({}), set: async () => {} },
    toolbox: null,
    oneShot: { claude: { complete: async () => '' }, local: { complete: async () => '' } },
    workers: { list: async () => [], get: async () => null, stop: async () => {} },
    version: 'test',
    log: () => {},
  })
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`
  const call = (path: string, init: RequestInit = {}, key: string | null = KEY) =>
    fetch(base + path, { ...init, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...init.headers } })
  const upload = (chat: string, name: string, body: BodyInit) =>
    call(`/chats/${chat}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', body })
  return { call, upload, calls, root, close: () => { hub.close(); hub.closeAllConnections() } }
}

test('upload a photo, send it, and the Assistant turn gets the file', async () => {
  const h = await start()
  try {
    const up = await h.upload('assistant', 'cat.png', 'png-bytes')
    assert.equal(up.status, 201)
    const file = await up.json()
    assert.deepEqual({ name: file.name, type: file.type, size: file.size }, { name: 'cat.png', type: 'image/png', size: 9 })

    const sent = await h.call('/chats/assistant/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '', attachments: [file.id] }),
    })
    assert.equal(sent.status, 202)
    const msg = await sent.json()
    assert.deepEqual(msg.attachments, [file]) // the path on the box is not sent to the browser
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(h.calls[0]!.attachments?.[0]?.path, join(h.root, 'assistant', file.id, 'cat.png'))

    // The thumbnail: the bytes, as an image, never cached by Cloudflare.
    const img = await h.call(`/chats/assistant/attachments/${file.id}`)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.match(img.headers.get('cache-control') ?? '', /^private/)
    assert.equal(await img.text(), 'png-bytes')
  } finally {
    h.close()
  }
})

test('other files download as plain bytes, sandboxed', async () => {
  const h = await start()
  try {
    const file = await (await h.upload('assistant', 'page.html', '<script>alert(1)</script>')).json()
    const r = await h.call(`/chats/assistant/attachments/${file.id}`)
    assert.equal(r.headers.get('content-type'), 'application/octet-stream')
    assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''page\.html/)
    assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/)
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  } finally {
    h.close()
  }
})

test('uploads need the key and have a size cap; local-model chats take them too', async () => {
  const h = await start()
  try {
    // From anywhere but this computer's own browser (here: through a tunnel), only the key gets in.
    assert.equal((await h.call('/chats/assistant/attachments?name=a.txt', { method: 'POST', body: 'x', headers: { 'cf-connecting-ip': '203.0.113.9' } }, null)).status, 401)
    const big = await h.upload('assistant', 'big.bin', new Uint8Array(MAX_FILE_BYTES + 1))
    assert.equal(big.status, 413)
    assert.match((await big.json()).error, /20 MB/)

    const local = await (await h.call('/chats', { method: 'POST', body: '{}' })).json()
    assert.equal((await h.upload(local.id, 'a.txt', 'x')).status, 201)

    assert.equal((await h.call('/chats/assistant/attachments/00000000-0000-4000-8000-000000000000')).status, 404)
    const gone = await h.call('/chats/assistant/messages', {
      method: 'POST', body: JSON.stringify({ text: 'hi', attachments: ['00000000-0000-4000-8000-000000000000'] }),
    })
    assert.equal(gone.status, 400)
    assert.equal((await h.call('/chats/assistant/messages', { method: 'POST', body: JSON.stringify({ text: '  ' }) })).status, 400)
  } finally {
    h.close()
  }
})
