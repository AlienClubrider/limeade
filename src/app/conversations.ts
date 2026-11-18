// Every conversation the app shows: plain chats and the Assistant thread. Turns in one conversation run
// strictly one at a time; different conversations run side by side.

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  ASSISTANT_ID, handoverPrompt, isEffort, isMode, notificationText, readQuiet, summarize, cleanTitle, titleFrom, titleRequest, trimThread,
  type Chat, type ChatSummary, type LiveTurn, type Message, type QueuedTurn, type Source, type Step, type WorkerInfo,
} from '../domain/chat.ts'
import { eventMarker, eventsToWake, noticeKindFor, noticeTitle, wakeMessage, type FleetEvent } from '../domain/fleet.ts'
import { DEFAULT_ASSISTANT_MODEL, agentLabel, agentOfEngine, historyFor, isAgent, parseModelId, turnEngine, type Agent, type TurnEngineKey } from '../domain/models.ts'
import { questionLine, readNeeds, reaskPrompt, type InboxItem } from '../domain/inbox.ts'
import { MAX_FILE_BYTES, attachmentIds, type Attachment, type StoredAttachment } from '../domain/attachments.ts'
import { DEFAULT_MACHINE, machines, type Where } from '../domain/places.ts'
import type {
  ApprovalDecision, ApprovalRequest, AttachmentStore, ChatStore, EngineEvent, FleetLog, FleetModeStore, HomeFolders, InboxStore, KeyValue, Notice, NoticeLog, OneShot, TurnEngine,
  TurnRequest, TurnResult,
} from '../ports.ts'

/** What the Assistant is told about how it's reached, on Claude Code or Codex alike. */
const APP_NOTE = [
  "You are reached through Limeade, the user's app on their phone or computer, not your agent's own app.",
  'Each reply becomes a notification showing your TL;DR line, so always start with it.',
  "Start a reply with [quiet] when the user needn't be buzzed (for example a routine event you fully handled).",
  "When a reply needs the user (a decision, a question, something to look at), end it with the question; if there is no question but they must look, start the reply with [needs you]. That puts it in the app's bell.",
]

/**
 * How the Assistant reaches its workers. `scripts`: a server's own fleet scripts (named as the Assistant
 * sees them, "~/bin/fleet"); `builtin`: the hub runs workers and bundles a `fleet` command; none: no workers.
 */
export type FleetNotes =
  | { kind: 'scripts'; fleet: string; fleetDir: string; handoff: string | null }
  | { kind: 'builtin' }

/** The command the Assistant acks fleet events with. */
export function ackCommand(f: FleetNotes | null | undefined): string {
  return f?.kind === 'scripts' ? `${f.fleet} ack` : 'fleet ack'
}

function fleetNote(f: FleetNotes): string[] {
  if (f.kind === 'scripts') {
    return [
      `Fleet events arrive as messages starting with "[fleet event]": handle them exactly as you would a fleet-rewake wake-up, then ${f.fleet} ack.`,
      `Do not write your session id to ${f.fleetDir}/assistant-session; the hub delivers fleet events to you.`,
      'When your context gets large, hand off yourself: run the wrap-up skill, tell the user in one line, then after your reply schedule POST /chats/assistant/new-session (see assistant.md); never ask them to start it.',
    ]
  }
  return [
    'Hand bigger jobs to workers: other agent sessions that run beside you, each in its own folder. Write the brief to a file first (goal, where, what done looks like, what not to touch), then run `fleet start <agent> "<Title>" <folder> <brief-file>` (`-` as the agent runs it without a persona; `--model <id>` picks its model, else it gets yours).',
    "Workers are the only handed-off work the user can see: they show on Limeade's Workers page, and your own subagents (helpers you start inside your turn) never do. So any job you hand off goes to a worker, even where other instructions say to use your subagents; keep subagents for quick lookups you finish within this reply. Tell the user a job is started only after `fleet start` succeeded, naming the worker.",
    '`fleet list` shows your workers, `fleet show <name>` one worker\'s reports and last reply, `fleet send <name> "<text>"` answers or steers it, `fleet stop <name>` stops it. Track jobs with `fleet task add|set|list`; `fleet digest` shows everything.',
    'Worker news arrives as messages starting with "[fleet event]": handle each (answer the worker yourself when the user already decided; otherwise tell the user), then run `fleet ack`.',
  ]
}

export function assistantNote(fleet: FleetNotes | null | undefined): string {
  return [...APP_NOTE, ...(fleet ? fleetNote(fleet) : [])].join(' ')
}

/** Put before the first message of a new Assistant session: pick up where the last one left off. */
export function freshStart(fleet: FleetNotes | null | undefined): string {
  if (!fleet) return ''
  if (fleet.kind === 'builtin') {
    return '(New assistant conversation, reached through Limeade. Before anything else, run `fleet digest` to see your workers and jobs so far.)\n\n'
  }
  return `(New assistant conversation, reached through Limeade. Before anything else, run ${fleet.fleet} digest` +
    `${fleet.handoff ? ` and read ${fleet.handoff}` : ''} to pick up where the last assistant left off.)\n\n`
}

/** Told to every worker the hub runs, on top of its persona. */
export const WORKER_NOTE = [
  "You are a worker: the user's Assistant started you for one job and reads your reports, reached through Limeade.",
  'Report with `fleet status <state> "<one line>"` (states: working, paused, needs-decision, blocked, done, failed): working when you start,',
  'needs-decision with the question when you need an answer (then end your turn; the answer comes as your next message), blocked when something stops you,',
  'done with the outcome when the job is finished, failed if you give up. Every turn that ends with you stopping work ends with one of these.',
].join(' ')

/** Said in the thread when a turn was cut off by the hub stopping or restarting (one that couldn't outlive it). */
export const RESTARTED = "That didn't finish: the hub restarted in the middle of it. Ask again if you still need it."

/** A turn's result, with the agent whose session it ran in. */
type AgentResult = TurnResult & { agent?: Agent }

export interface PendingApproval extends ApprovalRequest {
  id: string
  chatId: string
  chatTitle: string
  at: string
}

export interface ChatState extends Chat {
  busy: boolean
  /** The running turn so far, so a page that (re)loads mid-reply shows all of it. */
  live?: LiveText
}

interface LiveText {
  messageId: string
  text: string
  steps: Step[]
}

export class HubError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface Deps {
  store: ChatStore
  notices: NoticeLog
  /** Claude Code on Claude and local models; Codex (when it's set up on this hub) on its own and local models. */
  engines: { claude: TurnEngine; local: TurnEngine; codex?: TurnEngine; codexLocal?: TurnEngine }
  fleet: FleetLog
  fleetMode: FleetModeStore
  /** alias -> latest Claude model id, so the picker can say "Opus 5.5". */
  claudeVersions: KeyValue
  defaultChatModel: string
  /** The bell (Assistant only). */
  inbox?: InboxStore
  /** Files sent with messages (Claude chats only). */
  uploads?: AttachmentStore
  /** Where plain chats may run (folders under home), and the folder a new chat starts in. */
  folders?: HomeFolders
  defaultFolder?: string
  /**
   * Names a plain chat after its first exchange: Claude chats ask Haiku, local chats ask their own model
   * (so a local conversation stays on the user's machines). Without it, chats keep their first-message title.
   */
  titler?: { claude: OneShot; local: OneShot }
  /** This computer's name in "where" (Settings shows it too). */
  machineName?: string
  /** How the Assistant reaches workers (and is told so); none: it has no workers. */
  fleetNotes?: FleetNotes | null
  now?: () => Date
}

/**
 * Emits:
 *  'message'  { chatId, message }               a new or finished message
 *  'delta'    { chatId, messageId, text, at }   streamed reply text; `at` is where it goes in the reply so far
 *  'live'     { chatId, messageId, text, steps } a running turn so far (picked up after a hub restart)
 *  'step'     { chatId, messageId, step }       a tool call in a running turn
 *  'busy'     { chatId, busy }
 *  'approval' PendingApproval
 *  'approval_done' { id, decision }             answered, or 'expired' when its turn ended
 *  'notice'   Notice
 *  'chat'     ChatSummary                       created, renamed or deleted (deleted: true)
 *  'inbox'    { items: InboxItem[] }            the bell changed
 */
export class Conversations extends EventEmitter {
  private d: Deps
  private tails = new Map<string, Promise<unknown>>()
  private running = new Map<string, AbortController>()
  private approvals = new Map<string, { pending: PendingApproval; answer: (d: ApprovalDecision, m?: string) => void }>()
  private now: () => Date
  private closing = false
  /** Chats whose running turn outlives the hub (Claude Code, in its keeper). */
  private kept = new Set<string>()
  private writes = new Set<Promise<unknown>>()
  private live = new Map<string, LiveText>()

  constructor(deps: Deps) {
    super()
    this.d = deps
    this.now = deps.now ?? (() => new Date())
    // Approvals are asked again by turns that are picked up; the old bell items point at nothing.
    void this.clearInbox((i) => i.kind === 'approval')
    this.resumeTurns()
  }

  /**
   * The hub is stopping (usually a restart). Claude Code turns keep running and the next hub picks them
   * up; queued turns wait for it. Anything else (a chat-only model's request) stops and saves what it had.
   */
  async close(): Promise<void> {
    this.closing = true
    const others = () => [...this.running].filter(([id]) => !this.kept.has(id))
    for (const [, ctl] of others()) ctl.abort()
    while (others().length) await new Promise((r) => setTimeout(r, 10))
    await Promise.allSettled([...this.writes])
  }

  /**
   * At start: pick up the turns an earlier hub left running, then the turns queued behind them. A turn
   * that can't be picked up (the hub died with a plain chat's request, or the box went down) is said out loud.
   */
  private resumeTurns() {
    for (const chat of this.d.store.list()) {
      const live = chat.liveTurn
      const engine = live ? this.d.engines[live.engine] : undefined
      if (live && engine?.reattach) this.pickUp(chat.id, live, engine)
      else if (chat.turnRunning) {
        void this.chain(chat.id, async () => {
          await this.addMessage(chat.id, this.newMessage('error', 'system', RESTARTED))
          await this.markTurn(chat.id, false)
        })
      }
      for (const q of chat.queuedTurns ?? []) void this.queue(chat.id, q)
    }
  }

  private async markTurn(id: string, on: boolean) {
    if (id !== ASSISTANT_ID && !this.d.store.get(id)) return // deleted mid-turn
    await this.save(id, ({ turnRunning: _, liveTurn: _l, ...c }) => (on ? { ...c, turnRunning: this.now().toISOString() } : c))
  }

  // ---------- reading ----------

  list(): ChatSummary[] {
    return this.d.store
      .list()
      .filter((c) => c.kind === 'chat')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => summarize(this.withWhere(c)))
  }

  get(id: string): ChatState {
    const chat = id === ASSISTANT_ID ? this.assistant() : this.d.store.get(id)
    if (!chat) throw new HubError(404, 'No such chat')
    const live = this.live.get(id)
    return { ...this.withWhere(chat), busy: this.running.has(id) || this.queuedFor(id), ...(live ? { live: { ...live, steps: [...live.steps] } } : {}) }
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.approvals.values()].map((a) => a.pending)
  }

  busyChats(): string[] {
    return [...this.running.keys()]
  }

  // ---------- changing ----------

  async create(opts: { model?: unknown; effort?: unknown; where?: unknown; agent?: unknown }): Promise<ChatState> {
    const where = opts.where === undefined ? this.defaultWhere() : await this.validWhere(opts.where)
    const agent = opts.agent === undefined ? 'claude' : this.validAgent(opts.agent)
    const model = this.validModel(opts.model) ?? this.d.defaultChatModel
    this.checkFits(agent, model)
    const at = this.now().toISOString()
    const chat: Chat = {
      id: randomUUID(),
      kind: 'chat',
      title: 'New chat',
      model,
      effort: isEffort(opts.effort) ? opts.effort : 'medium',
      mode: 'auto',
      claudeSession: null,
      ...(agent !== 'claude' ? { agent } : {}),
      ...(where ? { where } : {}),
      createdAt: at,
      updatedAt: at,
      messages: [],
    }
    await this.d.store.save(chat)
    this.emit('chat', summarize(chat))
    return { ...chat, busy: false }
  }

  /**
   * A worker the Assistant starts: a chat in its folder, named by the Assistant, on the given agent and
   * model (else the Assistant's), in auto mode, told the brief as its first message.
   */
  async createWorker(o: { title: string; worker: WorkerInfo; folder: string; brief: string; agent?: unknown; model?: unknown }): Promise<ChatState> {
    const assistant = this.assistant()
    const where = await this.validWhere({ folder: o.folder })
    const agent = o.agent === undefined ? (assistant.agent ?? 'claude') : this.validAgent(o.agent)
    const model = o.model === undefined ? assistant.model : this.validModel(o.model)
    if (!model) throw new HubError(400, 'Unknown model')
    this.checkFits(agent, model)
    const at = this.now().toISOString()
    const chat: Chat = {
      id: randomUUID(),
      kind: 'chat',
      title: o.title,
      renamed: true,
      model,
      effort: assistant.effort,
      mode: 'auto',
      claudeSession: null,
      ...(agent !== 'claude' ? { agent } : {}),
      where,
      worker: o.worker,
      createdAt: at,
      updatedAt: at,
      messages: [],
    }
    await this.d.store.save(chat)
    this.emit('chat', summarize(chat))
    await this.send(chat.id, o.brief)
    return this.get(chat.id)
  }

  /** Changes a worker's record (e.g. stopped), keeping the chat. */
  async setWorker(id: string, worker: WorkerInfo): Promise<void> {
    await this.save(id, (c) => ({ ...c, worker }))
  }

  /**
   * Model, effort, mode, title or where (machine and folder). Claude Code keeps its sessions per folder,
   * so a new folder starts a fresh Claude session.
   */
  async update(id: string, patch: { model?: unknown; effort?: unknown; mode?: unknown; title?: unknown; where?: unknown; agent?: unknown }): Promise<ChatState> {
    const chat = this.get(id)
    const next: Chat = { ...chat }
    if (patch.where !== undefined) {
      if (chat.kind !== 'chat') throw new HubError(400, 'The Assistant always works from ~/dev')
      const where = await this.validWhere(patch.where)
      if (where.folder !== chat.where?.folder || where.machine !== chat.where?.machine) {
        next.where = where
        next.claudeSession = null
      }
    }
    if (patch.model !== undefined) {
      const model = this.validModel(patch.model)
      if (!model) throw new HubError(400, 'Unknown model')
      next.model = model
    }
    if (patch.agent !== undefined) {
      const agent = this.validAgent(patch.agent)
      if (agent === 'claude') delete next.agent
      else next.agent = agent
    }
    if (patch.model !== undefined || patch.agent !== undefined) this.checkFits(next.agent ?? 'claude', next.model)
    if (patch.effort !== undefined) {
      if (!isEffort(patch.effort)) throw new HubError(400, 'effort must be low, medium or high')
      next.effort = patch.effort
    }
    if (patch.mode !== undefined) {
      if (!isMode(patch.mode)) throw new HubError(400, 'mode must be ask, acceptEdits, auto or plan')
      next.mode = patch.mode
    }
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || !patch.title.trim()) throw new HubError(400, 'Give it a title')
      next.title = titleFrom(patch.title, 80)
      next.renamed = true
    }
    const { busy: _busy, ...plain } = next as ChatState
    await this.d.store.save(plain)
    if (chat.kind === 'chat') this.emit('chat', summarize(plain))
    return { ...plain, busy: chat.busy }
  }

  async remove(id: string): Promise<void> {
    if (id === ASSISTANT_ID) throw new HubError(400, "The Assistant thread can't be deleted")
    const chat = this.get(id)
    this.stop(id)
    await this.d.store.remove(id)
    this.emit('chat', { ...summarize(chat), deleted: true })
  }

  /** One file for a coming message, saved on the box. */
  async upload(id: string, name: unknown, body: AsyncIterable<Uint8Array>): Promise<Attachment> {
    this.get(id)
    if (!this.d.uploads) throw new HubError(503, 'Uploads are not set up on this hub')
    const saved = await this.d.uploads.save(id, typeof name === 'string' && name ? name : 'file', body, MAX_FILE_BYTES)
    if (saved === 'too-big') throw new HubError(413, `Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB`)
    return saved
  }

  /** A file sent in this chat, to show or download. */
  async attachment(id: string, fileId: string): Promise<StoredAttachment> {
    this.get(id)
    const file = await this.d.uploads?.get(id, fileId)
    if (!file) throw new HubError(404, 'No such file')
    return file
  }

  /** The user's message. Recorded at once; the reply streams and lands when its turn has run. */
  async send(id: string, text: unknown, attachments?: unknown): Promise<Message> {
    let ids: string[]
    try {
      ids = attachmentIds(attachments)
    } catch (err) {
      throw new HubError(400, (err as Error).message)
    }
    if (typeof text !== 'string' || (!text.trim() && !ids.length)) throw new HubError(400, 'Say something')
    const chat = this.get(id)
    const files: StoredAttachment[] = []
    for (const fileId of ids) {
      const f = await this.d.uploads?.get(id, fileId)
      if (!f) throw new HubError(400, 'One of the files is gone; attach it again')
      files.push(f)
    }
    const message: Message = {
      ...this.newMessage('user', 'chat', text.trim()),
      ...(files.length ? { attachments: files.map(({ path: _p, ...a }) => a) } : {}),
    }
    const title = chat.kind === 'chat' && !chat.renamed && chat.messages.length === 0 ? titleFrom(text || files[0]!.name) : chat.title
    await this.save(id, (c) => ({ ...c, title, messages: [...c.messages, message] }))
    if (title !== chat.title) this.emit('chat', summarize(this.d.store.get(id)!))
    this.emit('message', { chatId: id, message })
    void this.enqueue(id, 'chat', message.text, [], message.id, files)
    // He answered: open questions and "look at this" items are done.
    if (id === ASSISTANT_ID) await this.clearInbox((i) => i.kind !== 'approval')
    return message
  }

  // ---------- the bell ----------

  inboxItems(): InboxItem[] {
    return [...(this.d.inbox?.all() ?? [])].sort((a, b) => a.at.localeCompare(b.at))
  }

  async dismiss(itemId: string): Promise<void> {
    const item = this.d.inbox?.all().find((i) => i.id === itemId)
    if (!item) return
    if (item.kind === 'approval') throw new HubError(400, 'Answer the approval instead')
    await this.clearInbox((i) => i.id === itemId)
  }

  /** An old item: the assistant asks it again at the bottom of the thread, with context. */
  async reask(itemId: string): Promise<void> {
    const item = this.d.inbox?.all().find((i) => i.id === itemId)
    if (!item) throw new HubError(404, 'That item is already done')
    if (item.kind === 'approval') throw new HubError(400, 'Answer the approval instead')
    await this.clearInbox((i) => i.id === itemId)
    void this.enqueue(ASSISTANT_ID, 'chat', reaskPrompt(item), [])
  }

  /** A harmless bell item with a real notification, to check the bell and push end to end. */
  async testInboxItem(): Promise<InboxItem | null> {
    const item = await this.addInbox({ kind: 'look', title: 'Test from Limeade', body: 'The bell and notifications work. Swipe this away.' })
    await this.notify({ kind: 'needs', title: 'Please look', body: 'Test from Limeade', chatId: ASSISTANT_ID, inboxId: item?.id })
    return item
  }

  private async addInbox(item: Omit<InboxItem, 'id' | 'at'>): Promise<InboxItem | null> {
    if (!this.d.inbox) return null
    const saved: InboxItem = { ...item, id: randomUUID(), at: this.now().toISOString() }
    await this.d.inbox.put(saved)
    this.emit('inbox', { items: this.inboxItems() })
    return saved
  }

  private async clearInbox(match: (i: InboxItem) => boolean): Promise<void> {
    const gone = (this.d.inbox?.all() ?? []).filter(match)
    if (!gone.length) return
    for (const i of gone) await this.d.inbox!.remove(i.id)
    this.emit('inbox', { items: this.inboxItems() })
  }

  /** Stops the running turn (Claude: an interrupt, then a kill). Queued turns still run. */
  stop(id: string): boolean {
    const ctl = this.running.get(id)
    if (!ctl) return false
    ctl.abort()
    return true
  }

  answer(approvalId: string, decision: unknown, message?: unknown): void {
    const a = this.approvals.get(approvalId)
    if (!a) throw new HubError(404, 'That approval has already been answered or has expired')
    if (decision !== 'yes' && decision !== 'always' && decision !== 'no') throw new HubError(400, 'decision must be yes, always or no')
    this.approvals.delete(approvalId)
    a.answer(decision, typeof message === 'string' ? message.trim() : undefined)
    this.emit('approval_done', { id: approvalId, decision })
    void this.clearInbox((i) => i.approvalId === approvalId)
  }

  /** The next Assistant turn starts a new session (after the current one finishes). */
  async newAssistantSession(): Promise<void> {
    await this.chain(ASSISTANT_ID, async () => {
      await this.save(ASSISTANT_ID, (c) => ({ ...c, claudeSession: null }))
      await this.addMessage(ASSISTANT_ID, this.newMessage('event', 'system', 'New conversation started'))
    })
  }

  /** Hands unwoken fleet events to the Assistant, only while the fleet mode is "app". */
  async checkFleet(): Promise<boolean> {
    if ((await this.d.fleetMode.get()) !== 'app') return false
    const events = eventsToWake(await this.d.fleet.lines(), await this.d.fleet.cursor(), await this.d.fleet.lastWake())
    if (events.length === 0) return false
    await this.d.fleet.setLastWake(events.at(-1)!.seq)
    for (const e of events) await this.addMessage(ASSISTANT_ID, this.newMessage('event', 'fleet', eventMarker(e)))
    void this.enqueue(ASSISTANT_ID, 'fleet', wakeMessage(events, ackCommand(this.d.fleetNotes)), events)
    return true
  }

  // ---------- turns ----------

  private pending = new Map<string, number>()

  private queuedFor(id: string): boolean {
    return (this.pending.get(id) ?? 0) > 0
  }

  private chain<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(id) ?? Promise.resolve()).then(work)
    const tail = run.catch(() => undefined)
    this.tails.set(id, tail)
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id)
    })
    return run
  }

  /** A new turn: kept in the chat until it starts, so a hub restart doesn't drop it. */
  private enqueue(
    id: string, source: Source, prompt: string, events: readonly FleetEvent[], userMessageId?: string, attachments: readonly StoredAttachment[] = [],
  ): Promise<void> {
    const q: QueuedTurn = {
      id: randomUUID(),
      source,
      prompt,
      ...(userMessageId ? { userMessageId } : {}),
      ...(attachments.length ? { attachmentIds: attachments.map((a) => a.id) } : {}),
      ...(events.length ? { events: [...events] } : {}),
    }
    void this.save(id, (c) => ({ ...c, queuedTurns: [...(c.queuedTurns ?? []), q] })).catch(() => undefined)
    return this.queue(id, q, attachments)
  }

  private queue(id: string, q: QueuedTurn, attachments?: readonly StoredAttachment[]): Promise<void> {
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1)
    this.emit('busy', { chatId: id, busy: true })
    return this.chain(id, async () => {
      let counted = true
      try {
        // Stopping: leave it queued for the next hub.
        if (this.closing) return
        const files = attachments ?? (await this.filesFor(id, q.attachmentIds ?? []))
        // From here to the turn running, nothing waits, so the chat never looks idle in between.
        this.pending.set(id, (this.pending.get(id) ?? 1) - 1)
        counted = false
        void this.save(id, (c) => ({ ...c, queuedTurns: c.queuedTurns?.filter((x) => x.id !== q.id) })).catch(() => undefined)
        await this.runTurn(id, q.source, q.prompt, q.events ?? [], q.userMessageId, files)
      } finally {
        if (counted) this.pending.set(id, (this.pending.get(id) ?? 1) - 1)
        if (!this.queuedFor(id) && !this.kept.has(id)) this.emit('busy', { chatId: id, busy: false })
      }
    })
  }

  private async filesFor(id: string, ids: readonly string[]): Promise<StoredAttachment[]> {
    const files: StoredAttachment[] = []
    for (const fileId of ids) {
      const f = await this.d.uploads?.get(id, fileId)
      if (f) files.push(f)
    }
    return files
  }

  private async runTurn(
    id: string, source: Source, prompt: string, events: readonly FleetEvent[], userMessageId: string | undefined, attachments: readonly StoredAttachment[],
  ): Promise<void> {
    const chat = this.get(id)
    const parsed = parseModelId(chat.model)
    const replyId = randomUUID()
    const isAssistant = chat.kind === 'assistant'
    await this.drive(id, chat, { replyId, source, events, model: chat.model }, async (signal, onEvent) => {
      await this.markTurn(id, true)
      if (!parsed) throw new Error(`Unknown model ${chat.model}`)
      const agent: Agent = chat.agent ?? 'claude'
      const key = turnEngine(agent, parsed.engine)
      const engine = key ? this.d.engines[key] : undefined
      if (!key || !engine) throw new Error(key ? `${agentLabel(agent)} isn't set up on this hub` : `${agentLabel(agent)} can't run ${chat.model}`)
      // Everything before this turn's own message (later queued messages aren't history yet).
      const upTo = userMessageId ? chat.messages.findIndex((m) => m.id === userMessageId) : chat.messages.length
      const history = chat.messages.slice(0, upTo < 0 ? chat.messages.length : upTo).filter((m) => m.role === 'user' || m.role === 'assistant')
      // The other agent's session is no use to this one: start a new one that's told what was said (the
      // Assistant less of it: its thread is long, and its handoff carries the rest).
      const sessionAgent = chat.sessionAgent ?? 'claude'
      const handover = sessionAgent !== agent
      const session = handover ? null : chat.claudeSession
      const fleet = this.d.fleetNotes
      const firstPrompt = handover ? handoverPrompt(history, prompt, agentLabel(sessionAgent), ...(isAssistant ? [20, 1500] : [])) : prompt
      const attempt = (sessionId: string | null) =>
        engine.run({
          prompt: sessionId ? prompt : isAssistant ? freshStart(fleet) + firstPrompt : firstPrompt,
          ...(attachments.length ? { attachments } : {}),
          history: historyFor(parsed.engine, history),
          model: parsed.name,
          effort: chat.effort,
          mode: chat.mode,
          sessionId,
          ...(!isAssistant && chat.where ? { cwd: chat.where.folder } : {}),
          agent: isAssistant ? 'assistant' : chat.worker?.persona,
          appendSystemPrompt: isAssistant ? assistantNote(fleet) : chat.worker ? WORKER_NOTE : undefined,
          ...(chat.worker ? { env: { FLEET_SLUG: chat.worker.slug } } : {}),
          signal,
          onEvent,
          // It runs on without the hub: remember how to pick it up after a restart.
          onStart: (handle) => {
            this.kept.add(id)
            const live: LiveTurn = { engine: key, handle, replyId, source, model: chat.model, ...(events.length ? { events: [...events] } : {}) }
            void this.save(id, (c) => (c.turnRunning ? { ...c, liveTurn: live } : c)).catch(() => undefined)
          },
        })
      const result = await attempt(session)
      const lost = result.sessionLost && !this.closing
      if (lost) this.kept.delete(id)
      return { ...(lost ? await attempt(null) : result), agent: agentOfEngine(key) }
    })
  }

  /** A turn an earlier hub started, still running in its keeper: follow it to the end like any other. */
  private pickUp(id: string, live: LiveTurn, engine: TurnEngine) {
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1)
    this.kept.add(id)
    this.emit('busy', { chatId: id, busy: true })
    void this.chain(id, async () => {
      this.pending.set(id, (this.pending.get(id) ?? 1) - 1)
      try {
        const chat = this.get(id)
        const parsed = parseModelId(live.model)
        const agent = agentOfEngine(live.engine)
        await this.drive(id, chat, { replyId: live.replyId, source: live.source, events: live.events ?? [], model: live.model }, async (signal, onEvent) => {
          const result = await engine.reattach!(live.handle, {
            prompt: '', history: [], model: parsed?.name ?? live.model, effort: chat.effort, mode: chat.mode,
            sessionId: (chat.sessionAgent ?? 'claude') === agent ? chat.claudeSession : null, signal, onEvent,
          })
          return result && { ...result, agent }
        })
      } finally {
        if (!this.queuedFor(id) && !this.kept.has(id)) this.emit('busy', { chatId: id, busy: false })
      }
    })
  }

  /**
   * Runs one turn to the end and lands what it said. `go` starts (or picks up) the engine's turn; null
   * from it means the turn was lost with an earlier hub.
   */
  private async drive(
    id: string,
    chat: Chat,
    t: { replyId: string; source: Source; events: readonly FleetEvent[]; model: string },
    go: (signal: AbortSignal, onEvent: TurnRequest['onEvent']) => Promise<AgentResult | null>,
  ): Promise<void> {
    const { replyId, source } = t
    const steps: Step[] = []
    const ctl = new AbortController()
    this.running.set(id, ctl)
    this.live.set(id, { messageId: replyId, text: '', steps })
    let handedOver = false
    try {
      const result = await go(ctl.signal, (e) => this.onEngineEvent(id, chat.title, replyId, steps, e))
      // The hub is going down and the turn runs on: the next hub lands it.
      if (this.closing && this.kept.has(id)) {
        handedOver = true
        return
      }
      if (!result) {
        await this.addMessage(id, this.newMessage('error', source, RESTARTED))
        return
      }
      if (this.closing) {
        // The hub is going down: keep what it said so far as a normal reply, then say it didn't finish.
        if (result.text.trim()) await this.addMessage(id, { ...this.newMessage('assistant', source, result.text), id: replyId, steps, model: t.model })
        await this.addMessage(id, this.newMessage('error', source, RESTARTED))
        return
      }
      await this.land(id, chat, { ...t, steps, stopped: ctl.signal.aborted }, result)
    } catch (err) {
      await this.addMessage(id, { ...this.newMessage('error', source, `That didn't work: ${(err as Error).message}`), id: replyId })
    } finally {
      if (!handedOver) {
        this.running.delete(id)
        this.live.delete(id)
        this.kept.delete(id)
        await this.markTurn(id, false).catch(() => undefined)
        for (const [aid, a] of this.approvals) {
          if (a.pending.chatId === id) {
            this.approvals.delete(aid)
            this.emit('approval_done', { id: aid, decision: 'expired' })
            await this.clearInbox((i) => i.approvalId === aid)
          }
        }
      }
    }
  }

  /** A finished turn: its reply (or failure) into the thread, the bell and a notification. */
  private async land(
    id: string,
    chat: Chat,
    t: { replyId: string; source: Source; events: readonly FleetEvent[]; model: string; steps: Step[]; stopped: boolean },
    result: AgentResult,
  ): Promise<void> {
    const { replyId, source, events, steps, stopped } = t
    const isAssistant = chat.kind === 'assistant'
    // An agent's own and local models share its session, so switching models keeps the conversation.
    // A chat-only local model has no session and leaves it alone.
    const agent = result.agent ?? 'claude'
    if (result.sessionId && (result.sessionId !== chat.claudeSession || agent !== (chat.sessionAgent ?? 'claude'))) {
      await this.save(id, ({ sessionAgent: _, ...c }) => ({ ...c, claudeSession: result.sessionId, ...(agent !== 'claude' ? { sessionAgent: agent } : {}) }))
    }
    const unquiet = readQuiet(result.text)
    const quiet = unquiet.quiet
    const { text, needs } = isAssistant ? readNeeds(unquiet.text) : { text: unquiet.text, needs: null }
    if (result.error && !text && !stopped) {
      await this.addMessage(id, { ...this.newMessage('error', source, `That didn't work: ${result.error}`), id: replyId, steps })
      return
    }
    const reply: Message = {
      ...this.newMessage('assistant', source, text || (stopped ? 'Stopped.' : '')),
      id: replyId,
      steps,
      model: t.model,
      ...(quiet ? { quiet } : {}),
    }
    await this.addMessage(id, reply)
    if (chat.kind === 'chat' && !chat.renamed && text && !stopped && !result.error) void this.autoTitle(id, reply.id)
    // A failure is always said out loud in the thread, even after partial text.
    if (result.error && !stopped) {
      await this.addMessage(id, this.newMessage('error', source, `That didn't finish: ${result.error}`))
      await this.notify({ kind: 'reply', title: chat.kind === 'assistant' ? 'Assistant' : chat.title, body: `That didn't finish: ${result.error}`, chatId: id })
    } else if (needs && !stopped) {
      // It needs him: into the bell, and buzz as "a worker needs me" whatever the source.
      const item = await this.addInbox({
        kind: needs,
        title: needs === 'question' ? questionLine(text) : notificationText(text),
        body: notificationText(text),
        messageId: reply.id,
      })
      await this.notify({ kind: 'needs', title: needs === 'question' ? 'The assistant asks' : 'Please look', body: item?.title ?? notificationText(text), chatId: id, inboxId: item?.id })
    } else if (!quiet && !stopped) await this.noticeForReply(chat, reply, source, events)
  }

  private onEngineEvent(chatId: string, chatTitle: string, messageId: string, steps: Step[], e: EngineEvent): void {
    const live = this.live.get(chatId)
    if (e.type === 'text') {
      const at = live?.text.length ?? 0
      if (live) live.text += e.text
      this.emit('delta', { chatId, messageId, text: e.text, at })
    } else if (e.type === 'resumed') {
      steps.splice(0, steps.length, ...e.steps)
      if (live) live.text = e.text
      this.emit('live', { chatId, messageId, text: e.text, steps: e.steps })
    } else if (e.type === 'step') {
      steps.push(e.step)
      this.emit('step', { chatId, messageId, step: e.step })
    } else if (e.type === 'model') {
      if (this.d.claudeVersions.get()[e.alias] !== e.modelId) void this.d.claudeVersions.set(e.alias, e.modelId)
    } else if (e.type === 'approval') {
      const pending: PendingApproval = {
        ...e.request,
        id: randomUUID(),
        chatId,
        chatTitle: chatId === ASSISTANT_ID ? 'Assistant' : chatTitle,
        at: this.now().toISOString(),
      }
      this.approvals.set(pending.id, { pending, answer: e.answer })
      this.emit('approval', pending)
      const title = `${pending.chatTitle} wants to ${pending.tool === 'Bash' ? 'run' : `use ${pending.tool}`}`
      const body = pending.text || pending.description || pending.tool
      void (async () => {
        const item = chatId === ASSISTANT_ID ? await this.addInbox({ kind: 'approval', title, body, approvalId: pending.id }) : null
        // Answered while we were saving it: don't leave it behind.
        if (item && !this.approvals.has(pending.id)) return this.clearInbox((i) => i.id === item.id)
        await this.notify({ kind: 'approval', title, body, chatId, approvalId: pending.id, inboxId: item?.id })
      })()
    }
  }

  private async noticeForReply(chat: Chat, reply: Message, source: Source, events: readonly FleetEvent[]) {
    const body = notificationText(reply.text)
    if (!body) return
    if (source === 'fleet') {
      await this.notify({ kind: noticeKindFor(events), title: noticeTitle(events), body, chatId: chat.id })
    } else {
      await this.notify({ kind: 'reply', title: chat.kind === 'assistant' ? 'Assistant' : chat.title, body, chatId: chat.id })
    }
  }

  private async notify(n: Omit<Notice, 'seq' | 'at'>) {
    this.emit('notice', await this.d.notices.append(n))
  }

  // ---------- storage ----------

  private assistant(): Chat {
    const existing = this.d.store.get(ASSISTANT_ID)
    if (existing) return existing
    const at = this.now().toISOString()
    return {
      id: ASSISTANT_ID,
      kind: 'assistant',
      title: 'Assistant',
      model: DEFAULT_ASSISTANT_MODEL,
      effort: 'medium',
      mode: 'auto',
      claudeSession: null,
      createdAt: at,
      updatedAt: at,
      messages: [],
    }
  }

  private async save(id: string, change: (c: Chat) => Chat): Promise<Chat> {
    const current = id === ASSISTANT_ID ? this.assistant() : this.d.store.get(id)
    if (!current) throw new HubError(404, 'No such chat')
    const next = change(current)
    next.updatedAt = this.now().toISOString()
    if (next.kind === 'assistant') next.messages = trimThread(next.messages)
    const write = this.d.store.save(next)
    this.writes.add(write)
    void write.finally(() => this.writes.delete(write)).catch(() => undefined)
    await write
    return next
  }

  /** After the first exchange, a short title from one cheap call, unless he has named the chat himself. */
  private async autoTitle(id: string, replyId: string) {
    const chat = this.d.store.get(id)
    const parsed = chat && parseModelId(chat.model)
    const replies = chat?.messages.filter((m) => m.role === 'assistant') ?? []
    // Codex's models have no cheap one-shot here: those chats keep their first-message title.
    if (!this.d.titler || !chat || !parsed || parsed.engine === 'codex' || replies.length !== 1 || replies[0]!.id !== replyId) return
    const question = chat.messages.find((m) => m.role === 'user')
    const { system, prompt } = titleRequest(question?.text || question?.attachments?.[0]?.name || '', replies[0]!.text)
    let title: string | null = null
    try {
      const raw = await this.d.titler[parsed.engine as 'claude' | 'local'].complete({
        model: parsed.engine === 'claude' ? 'haiku' : parsed.name, effort: 'low', system, prompt,
      })
      title = cleanTitle(raw)
    } catch (err) {
      console.log(`chat title: ${(err as Error).message}`)
    }
    const now = this.d.store.get(id)
    if (!title || !now || now.renamed || now.title === title) return
    await this.save(id, (c) => ({ ...c, title }))
    this.emit('chat', summarize(this.d.store.get(id)!))
  }

  private async addMessage(id: string, message: Message) {
    if (id !== ASSISTANT_ID && !this.d.store.get(id)) return // deleted mid-turn
    await this.save(id, (c) => ({ ...c, messages: [...c.messages, message] }))
    this.emit('message', { chatId: id, message })
  }

  private newMessage(role: Message['role'], source: Source, text: string): Message {
    return { id: randomUUID(), at: this.now().toISOString(), role, source, text }
  }

  /** Plain chats made before "where" existed run where chats always ran: ~/dev on this box. */
  private withWhere(chat: Chat): Chat {
    if (chat.kind !== 'chat' || chat.where) return chat
    const where = this.defaultWhere()
    return where ? { ...chat, where } : chat
  }

  private defaultWhere(): Where | null {
    const folder = this.d.defaultFolder ?? this.d.folders?.home
    return folder ? { machine: DEFAULT_MACHINE, folder } : null
  }

  /** A machine that can run chats now, and a real folder inside home on it. */
  private async validWhere(v: unknown): Promise<Where> {
    const w = (v && typeof v === 'object' ? v : {}) as { machine?: unknown; folder?: unknown }
    const machine = machines(this.d.machineName).find((m) => m.id === (w.machine ?? DEFAULT_MACHINE))
    if (!machine) throw new HubError(400, 'Unknown machine')
    if (!machine.online) throw new HubError(400, `${machine.label} ${machine.note ? machine.note.toLowerCase() : 'is offline'}`)
    if (!this.d.folders) throw new HubError(503, 'Folders are not set up on this hub')
    const folder = await this.d.folders.resolve(typeof w.folder === 'string' ? w.folder : '')
    if (!folder) throw new HubError(400, 'That folder is not inside your home folder, or does not exist')
    return { machine: machine.id, folder }
  }

  /** Codex only when this hub has it. */
  private validAgent(v: unknown): Agent {
    if (!isAgent(v)) throw new HubError(400, 'agent must be claude or codex')
    if (v === 'codex' && !this.d.engines.codex) throw new HubError(400, "Codex isn't set up on this hub")
    return v
  }

  /** Claude's models run in Claude Code, Codex's in Codex; local models in either. */
  private checkFits(agent: Agent, model: string) {
    const parsed = parseModelId(model)
    if (parsed && !turnEngine(agent, parsed.engine)) throw new HubError(400, `${agentLabel(agent)} can't run that model: pick one of its own or a local one`)
  }

  private validModel(v: unknown): string | null {
    return typeof v === 'string' && parseModelId(v) ? v : null
  }
}

