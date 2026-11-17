// File-backed stores: chats (one JSON file each), notices, Claude versions, and the fleet records.
// Everything is private to the user the hub runs as (0600).

import { promises as fs, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Chat } from '../domain/chat.ts'
import { parseEventLine, parseFleetMode, type FleetMode } from '../domain/fleet.ts'
import { parseStatus, type StatusLine } from '../domain/workers.ts'
import type { ChatStore, FleetLog, FleetModeStore, FleetRecords, InboxStore, KeyValue, Notice, NoticeLog } from '../ports.ts'
import type { InboxItem } from '../domain/inbox.ts'

async function writeAtomic(path: string, data: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tmp, data, { mode: 0o600 })
  await fs.rename(tmp, path)
}

async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

const readInt = async (path: string) => Number.parseInt((await readText(path))?.trim() ?? '', 10) || 0
const SAFE_ID = /^[a-z0-9-]{1,64}$/i

/** Chats in memory, each written to <dir>/<id>.json on change. */
export class ChatFiles implements ChatStore {
  private dir: string
  private chats = new Map<string, Chat>()
  private writes = new Map<string, Promise<unknown>>()

  constructor(dir: string) {
    this.dir = dir
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {}
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const chat = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Chat
        if (chat?.id) this.chats.set(chat.id, chat)
      } catch {}
    }
  }

  list(): Chat[] {
    return [...this.chats.values()]
  }

  get(id: string): Chat | null {
    return this.chats.get(id) ?? null
  }

  save(chat: Chat): Promise<void> {
    if (!SAFE_ID.test(chat.id)) throw new Error('Bad chat id')
    this.chats.set(chat.id, chat)
    return this.serial(chat.id, () => writeAtomic(join(this.dir, `${chat.id}.json`), JSON.stringify(chat)))
  }

  remove(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) throw new Error('Bad chat id')
    this.chats.delete(id)
    return this.serial(id, () => fs.rm(join(this.dir, `${id}.json`), { force: true }))
  }

  private serial(id: string, work: () => Promise<unknown>): Promise<void> {
    const next = (this.writes.get(id) ?? Promise.resolve()).then(work, work)
    this.writes.set(id, next.catch(() => undefined))
    return next.then(() => undefined)
  }
}

/** The last few hundred notices, as JSONL. */
export class NoticeFile implements NoticeLog {
  private path: string
  private items: Notice[] = []
  private keep: number
  private writing: Promise<unknown> = Promise.resolve()

  constructor(path: string, keep = 300) {
    this.path = path
    this.keep = keep
    try {
      this.items = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l) as Notice]
        } catch {
          return []
        }
      })
    } catch {}
  }

  since(seq: number): Notice[] {
    return this.items.filter((n) => n.seq > seq)
  }

  async append(n: Omit<Notice, 'seq' | 'at'>): Promise<Notice> {
    const saved: Notice = { seq: (this.items.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString(), ...n }
    this.items.push(saved)
    if (this.items.length > this.keep) this.items = this.items.slice(-this.keep)
    const data = this.items.map((i) => JSON.stringify(i)).join('\n') + '\n'
    this.writing = this.writing.then(() => writeAtomic(this.path, data)).catch(() => undefined)
    await this.writing
    return saved
  }
}

export class JsonKeyValue implements KeyValue {
  private path: string
  private data: Record<string, string> = {}
  constructor(path: string) {
    this.path = path
    try {
      this.data = JSON.parse(readFileSync(path, 'utf8'))
    } catch {}
  }
  get() {
    return this.data
  }
  async set(key: string, value: string) {
    this.data = { ...this.data, [key]: value }
    await writeAtomic(this.path, JSON.stringify(this.data))
  }
}

/** ~/.claude/fleet: events.log (fleet-watch), cursor (fleet ack), rewake-seq (shared with fleet-rewake), assistant-mode. */
export class FleetDir implements FleetLog, FleetModeStore, FleetRecords {
  private dir: string
  private appending: Promise<unknown> = Promise.resolve()
  constructor(dir: string) {
    this.dir = dir
  }

  // Built-in workers: the hub is the only writer of events.log.

  async statusLines(slug: string): Promise<StatusLine[]> {
    if (!SAFE_ID.test(slug)) return []
    return parseStatus((await readText(join(this.dir, 'status', `${slug}.status`))) ?? '')
  }

  async backlog(): Promise<string> {
    return (await readText(join(this.dir, 'backlog.tsv'))) ?? ''
  }

  /** One event line, "<seq> <UTC time> <slug> <kind>: <text>", as fleet-watch writes them. */
  addEvent(slug: string, kind: string, text: string): Promise<void> {
    const run = this.appending.then(async () => {
      const last = parseEventLine((await this.lines()).at(-1) ?? '')?.seq ?? 0
      const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
      await fs.appendFile(join(this.dir, 'events.log'), `${last + 1} ${at} ${slug} ${kind}: ${text.replace(/\s+/g, ' ').trim()}\n`, { mode: 0o600 })
    })
    this.appending = run.catch(() => undefined)
    return run
  }

  async seen(slug: string): Promise<number> {
    return readInt(join(this.dir, 'watch', `${slug}.lines`))
  }

  async setSeen(slug: string, lines: number): Promise<void> {
    await writeAtomic(join(this.dir, 'watch', `${slug}.lines`), `${lines}\n`)
  }

  async lines() {
    return ((await readText(join(this.dir, 'events.log'))) ?? '').split('\n').filter(Boolean)
  }
  cursor() {
    return readInt(join(this.dir, 'cursor'))
  }
  lastWake() {
    return readInt(join(this.dir, 'rewake-seq'))
  }
  async setLastWake(seq: number) {
    await fs.writeFile(join(this.dir, 'rewake-seq'), `${seq}\n`)
  }
  async get(): Promise<FleetMode> {
    return parseFleetMode(await readText(join(this.dir, 'assistant-mode')))
  }
  async set(mode: FleetMode) {
    await fs.writeFile(join(this.dir, 'assistant-mode'), `${mode}\n`)
  }
}

/** Built-in workers: their news always goes to this hub's Assistant (there's no other one to choose). */
export class HubFleetMode implements FleetModeStore {
  readonly fixed = true
  async get(): Promise<FleetMode> {
    return 'app'
  }
  async set(): Promise<void> {}
}

/** The bell's open items (a handful at most), as one JSON file. */
export class InboxFile implements InboxStore {
  private path: string
  private items: InboxItem[] = []
  constructor(path: string) {
    this.path = path
    try {
      this.items = JSON.parse(readFileSync(path, 'utf8'))
    } catch {}
  }
  all() {
    return this.items
  }
  async put(item: InboxItem) {
    this.items = [...this.items.filter((i) => i.id !== item.id), item]
    await writeAtomic(this.path, JSON.stringify(this.items))
  }
  async remove(id: string) {
    this.items = this.items.filter((i) => i.id !== id)
    await writeAtomic(this.path, JSON.stringify(this.items))
  }
}
