// Built-in workers: the Assistant's helpers when there are no fleet scripts on the computer. Each worker is
// a chat the hub runs (in its own folder, as a persona, in auto mode), so it outlives hub restarts and can be
// read and answered on the Chat page. Workers report with the bundled `fleet status`; the hub turns what
// needs the Assistant into fleet events, the same lines fleet-watch writes on a server with the scripts.

import { CLAUDE_MODELS, CODEX_MODELS, localLabel, parseModelId } from '../domain/models.ts'
import { jobFor, latestOf, sortWorkers, type StatusLine, type WorkerDetail, type WorkerState, type WorkerSummary } from '../domain/workers.ts'
import { workerSlug } from '../domain/fleet.ts'
import type { Chat } from '../domain/chat.ts'
import type { FleetRecords, WorkerSource } from '../ports.ts'
import { HubError, type ChatState, type Conversations, type PendingApproval } from './conversations.ts'

/** Status lines the Assistant must hear about. */
const REPORTED = new Set(['needs-decision', 'blocked', 'done', 'failed'])

export interface StartWorker {
  /** The persona to run as; '-' or empty for none. */
  persona: string
  title: string
  folder: string
  brief: string
  agent?: unknown
  model?: unknown
}

interface Deps {
  conversations: Conversations
  records: FleetRecords
  /** This computer's name, shown in a worker's details. */
  machine: string
  /** Whether a persona exists in the agent the worker runs on. */
  hasPersona: (persona: string, agent: 'claude' | 'codex') => Promise<boolean>
}

export interface WorkerView extends WorkerDetail {
  chatId: string
  /** Its last reply, for the Assistant (`fleet show`). */
  reply: string
}

export class HubWorkers implements WorkerSource {
  private d: Deps
  /** Status lines a worker had when its current turn started. */
  private atTurnStart = new Map<string, Promise<number>>()

  constructor(d: Deps) {
    this.d = d
    const c = d.conversations
    c.on('busy', ({ chatId, busy }: { chatId: string; busy: boolean }) => {
      const chat = this.chat(chatId)
      if (!chat?.worker || chat.worker.stopped) return
      const slug = chat.worker.slug
      if (busy) {
        if (!this.atTurnStart.has(slug)) this.atTurnStart.set(slug, d.records.statusLines(slug).then((l) => l.length, () => 0))
      } else void this.turnEnded(chatId, slug).catch(() => undefined)
    })
    c.on('approval', (a: PendingApproval) => {
      const w = this.chat(a.chatId)?.worker
      if (w && !w.stopped) void d.records.addEvent(w.slug, 'prompt', `waiting on an approval: ${a.text || a.tool}`.slice(0, 240))
    })
  }

  private chat(id: string): ChatState | null {
    try {
      return this.d.conversations.get(id)
    } catch {
      return null
    }
  }

  private workers(): ChatState[] {
    return this.d.conversations.workerChats()
  }

  private bySlug(slug: string): ChatState | null {
    return this.workers().find((c) => c.worker!.slug === slug) ?? null
  }

  /** A turn ended: with no report in it, the Assistant hears it went quiet (or failed). */
  private async turnEnded(chatId: string, slug: string) {
    const counted = this.atTurnStart.get(slug)
    this.atTurnStart.delete(slug)
    if (!counted) return
    const before = await counted
    const chat = this.chat(chatId)
    if (!chat || chat.busy || chat.worker?.stopped) return
    if ((await this.d.records.statusLines(slug)).length > before) return
    const last = chat.messages.at(-1)
    if (last?.role === 'error') await this.d.records.addEvent(slug, 'stopped', `the turn failed: ${last.text}`.slice(0, 240))
    else await this.d.records.addEvent(slug, 'idle', 'finished a turn without a status line')
  }

  /** New status lines that need the Assistant become events (the hub's fleet tick). */
  async watch(): Promise<void> {
    for (const chat of this.workers()) {
      const slug = chat.worker!.slug
      const lines = await this.d.records.statusLines(slug)
      const seen = await this.d.records.seen(slug)
      if (lines.length === seen) continue
      for (const l of lines.slice(Math.min(seen, lines.length))) {
        if (REPORTED.has(l.state) && !chat.worker!.stopped) await this.d.records.addEvent(slug, 'reported', `${l.state}: ${l.text}`)
      }
      await this.d.records.setSeen(slug, lines.length)
    }
  }

  async start(o: StartWorker): Promise<WorkerView> {
    const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    if (!title) throw new HubError(400, 'Give the worker a title')
    if (typeof o.brief !== 'string' || !o.brief.trim()) throw new HubError(400, 'The brief is empty')
    const persona = typeof o.persona === 'string' && o.persona.trim() !== '-' ? o.persona.trim() : ''
    const agent = o.agent === 'codex' ? 'codex' : o.agent === 'claude' ? 'claude' : (this.d.conversations.get('assistant').agent ?? 'claude')
    if (persona && !(await this.d.hasPersona(persona, agent))) throw new HubError(400, `There's no agent named ${persona}; use one from the Agents page, or - for none`)
    const taken = new Set(this.workers().map((c) => c.worker!.slug))
    const slug = workerSlug(title, taken)
    const chat = await this.d.conversations.createWorker({
      title,
      worker: { slug, ...(persona ? { persona } : {}) },
      folder: o.folder,
      brief: o.brief,
      ...(o.agent !== undefined ? { agent: o.agent } : {}),
      ...(o.model !== undefined ? { model: o.model } : {}),
    })
    // Its reports start counting from now.
    await this.d.records.setSeen(slug, (await this.d.records.statusLines(slug)).length)
    return this.view(chat)
  }

  /** The Assistant answers or steers a worker: a new message in its chat. */
  async send(slug: string, text: unknown): Promise<void> {
    const chat = this.bySlug(slug)
    if (!chat || chat.worker!.stopped) throw new HubError(404, 'No such worker')
    await this.d.conversations.send(chat.id, text)
  }

  private async summary(chat: ChatState, backlog: string): Promise<WorkerSummary & { lines: StatusLine[] }> {
    const lines = await this.d.records.statusLines(chat.worker!.slug)
    const last = lines.at(-1)
    const waiting = this.d.conversations.pendingApprovals().some((a) => a.chatId === chat.id)
    const state: WorkerState = waiting ? 'needs'
      : chat.busy ? 'working'
      : last && (last.state === 'needs-decision' || last.state === 'blocked') ? 'needs'
      : last && (last.state === 'done' || last.state === 'failed') ? 'done'
      : 'idle'
    return {
      id: chat.worker!.slug,
      title: chat.title,
      state,
      now: last?.text ?? 'Starting',
      at: last?.at ?? null,
      job: jobFor(backlog, chat.title) ?? jobFor(backlog, chat.worker!.slug),
      activity: state === 'working' ? chat.live?.steps.at(-1)?.label ?? 'Working' : null,
      activeAt: latestOf(chat.updatedAt, last?.at),
      lines,
    }
  }

  private async view(chat: ChatState): Promise<WorkerView> {
    const { lines, ...s } = await this.summary(chat, await this.d.records.backlog())
    const reply = [...chat.messages].reverse().find((m) => m.role === 'assistant')?.text ?? ''
    return {
      ...s,
      lines: lines.slice(-6),
      startedAt: chat.createdAt,
      machine: this.d.machine,
      model: modelName(chat),
      agent: chat.worker!.persona ?? '',
      dir: chat.where?.folder ?? '',
      chatId: chat.id,
      reply,
    }
  }

  /** Workers that haven't been stopped. */
  async list(): Promise<WorkerSummary[]> {
    const backlog = await this.d.records.backlog()
    const all = await Promise.all(this.workers().filter((c) => !c.worker!.stopped).map((c) => this.summary(c, backlog)))
    return sortWorkers(all.map(({ lines: _l, ...s }) => s))
  }

  async get(id: string): Promise<WorkerView | null> {
    const chat = this.bySlug(id)
    return chat ? this.view(chat) : null
  }

  /** Stops its turn and takes it off the list; the chat stays. */
  async stop(id: string): Promise<void> {
    const chat = this.bySlug(id)
    if (!chat) throw new Error('No such worker')
    this.d.conversations.stop(chat.id)
    await this.d.conversations.setWorker(chat.id, { ...chat.worker!, stopped: true })
  }
}

/** "Opus", "GPT-6.1 Sol", "Gemma 4 26B": the worker's model as people say it. */
function modelName(chat: Chat): string {
  const p = parseModelId(chat.model)
  if (!p) return chat.model
  if (p.engine === 'claude') return CLAUDE_MODELS.find((m) => m.alias === p.name)?.family ?? p.name
  if (p.engine === 'codex') return CODEX_MODELS.find((m) => m.id === p.name)?.label ?? p.name
  return localLabel(p.name)
}
