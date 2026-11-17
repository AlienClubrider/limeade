// Uploads on disk: <root>/<chat id>/<upload id>/<file name>, private to the user the hub runs as. The folder per upload
// keeps his own file name, so the Assistant (and he, later) sees "invoice.pdf", not a hash.

import { createWriteStream, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isAttachmentId, safeFileName, typeFor, type Attachment, type StoredAttachment } from '../domain/attachments.ts'
import type { AttachmentStore } from '../ports.ts'

const SAFE_CHAT = /^[a-z0-9-]{1,64}$/i

export class UploadFiles implements AttachmentStore {
  private root: string
  constructor(root: string) {
    this.root = root
  }

  async save(chatId: string, rawName: string, body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Attachment | 'too-big'> {
    if (!SAFE_CHAT.test(chatId)) throw new Error('Bad chat id')
    const id = randomUUID()
    const name = safeFileName(rawName)
    const dir = join(this.root, chatId, id)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const out = createWriteStream(join(dir, name), { mode: 0o600 })
    const closed = new Promise<void>((resolve, reject) => {
      out.once('close', resolve)
      out.once('error', reject)
    })
    let size = 0
    let tooBig = false
    try {
      // Past the cap, keep draining without writing, so the sender still gets a clean answer.
      for await (const chunk of body) {
        size += chunk.length
        if (size > maxBytes) tooBig = true
        if (tooBig) continue
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      }
    } finally {
      out.end()
      await closed
    }
    if (tooBig) {
      await fs.rm(dir, { recursive: true, force: true })
      return 'too-big'
    }
    return { id, name, type: typeFor(name), size }
  }

  async get(chatId: string, id: string): Promise<StoredAttachment | null> {
    if (!SAFE_CHAT.test(chatId) || !isAttachmentId(id)) return null
    const dir = join(this.root, chatId, id)
    const name = (await fs.readdir(dir).catch(() => [] as string[]))[0]
    if (!name) return null
    const path = join(dir, name)
    const st = await fs.stat(path).catch(() => null)
    if (!st?.isFile()) return null
    return { id, name, type: typeFor(name), size: st.size, path }
  }
}
