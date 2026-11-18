// Conversations: plain chats and the one Assistant thread. Pure rules, no I/O.

import { attachmentsLabel } from './attachments.ts'
import type { FleetEvent } from './fleet.ts'
import type { Where } from './places.ts'

export type Role = 'user' | 'assistant' | 'event' | 'error'
export type Source = 'chat' | 'fleet' | 'system'
export type Effort = 'low' | 'medium' | 'high'
/** The app's mode chip. Mapped to Claude Code's permission modes by `cliPermissionMode`. */
export type Mode = 'ask' | 'acceptEdits' | 'auto' | 'plan'

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high']
export const MODES: readonly Mode[] = ['ask', 'acceptEdits', 'auto', 'plan']
export const ASSISTANT_ID = 'assistant'

/** One tool call, shown as one plain line when the user taps the turn's status line. */
export interface Step {
  tool: string
  text: string
  /** What it's doing, Claude Code style: "Running npm test", "Editing app.js", "Reading notes.md". */
  label?: string
  /** Where in the turn's streamed text it came, so the text before it reads as narration, not the reply. */
  at?: number
  /** When it started (ISO time), so a long-running one can say how long it has been going. */
  since?: string
}

export interface Message {
  id: string
  at: string // ISO time
  role: Role
  source: Source
  text: string
  /** Assistant replies: what it did on the way (tool calls). */
  steps?: Step[]
  /** Assistant replies: what it wrote on the way (between tool calls), each kept apart from the reply. */
  notes?: Note[]
  /** Assistant replies: the model id that answered. */
  model?: string
  /** Assistant replies: true when the user needn't be buzzed. */
  quiet?: boolean
  /** The user's messages: files they sent with it. */
  attachments?: import('./attachments.ts').Attachment[]
}

export interface Chat {
  id: string
  kind: 'chat' | 'assistant'
  title: string
  model: string
  effort: Effort
  mode: Mode
  /**
   * The agent session to resume: Claude Code's, or Codex's when `sessionAgent` says so (the name is from
   * before Codex; stored chats keep it). Local models share their agent's session.
   */
  claudeSession: string | null
  /** The agent the chat runs on; none is Claude. */
  agent?: import('./models.ts').Agent
  /** Whose session `claudeSession` is; none is Claude. A turn on the other agent starts a new one. */
  sessionAgent?: import('./models.ts').Agent
  /** Plain chats: the machine and folder it runs in (Claude models work in that folder). */
  where?: Where
  /** A worker the Assistant started (built-in workers): its name in fleet records, and its persona. */
  worker?: WorkerInfo
  /** Plain chats: the user named it, so it's never auto-titled. */
  renamed?: boolean
  /** When a turn started that hasn't finished yet; still set after a restart means the hub died mid-turn. */
  turnRunning?: string
  /** The running turn, when it outlives a hub restart (Claude Code turns): the next hub picks it up. */
  liveTurn?: LiveTurn
  /** Turns waiting behind the running one, so a hub restart doesn't drop them. */
  queuedTurns?: QueuedTurn[]
  createdAt: string
  updatedAt: string
  messages: Message[]
}

export interface WorkerInfo {
  /** Its name in fleet records ("dark-theme"): status file, events, FLEET_SLUG. */
  slug: string
  /** The agent (persona) it runs as; none is the agent's plain self. */
  persona?: string
  /** Stopped from the Workers page or by the Assistant: off the list, kept as a chat. */
  stopped?: boolean
}

/** What it takes to finish a turn the hub started before it restarted. */
export interface LiveTurn {
  engine: import('./models.ts').TurnEngineKey
  /** The engine's own name for the running turn. */
  handle: string
  replyId: string
  source: Source
  model: string
  events?: FleetEvent[]
  /**
   * Set once he has sent a message into the turn (steering): how much of the turn's text and how many
   * of its steps were already landed above his latest one. replyId is then the reply after it.
   */
  cut?: TurnCut
}

/** Where a running turn's reply was split by a message he sent into it: its text length and step count. */
export interface TurnCut {
  text: number
  steps: number
}

/** A running turn's text and steps from a cut on: what the reply below his latest message shows. */
export function afterCut(text: string, steps: readonly Step[], cut: TurnCut | undefined): { text: string; steps: Step[] } {
  if (!cut) return { text, steps: [...steps] }
  return {
    text: text.slice(cut.text),
    steps: steps.slice(cut.steps).map((s) => (typeof s.at === 'number' ? { ...s, at: Math.max(0, s.at - cut.text) } : s)),
  }
}

/** Words the agent wrote on the way, before the step (by index) it led into: an update, not the reply. */
export interface Note {
  text: string
  before: number
}

/**
 * A turn's words split at its steps: what came before a step is an update on the way, and the reply is
 * its last message (`final`, the engine's own), else what came after its latest step, else its latest
 * update when it ended on a step with nothing after it. So a turn with several updates never lands as one
 * long reply that repeats them. Steps without a place (older hubs) leave all the words as the reply.
 * public/live-turn.js splits the running turn the same way.
 */
export function turnParts(text: string, steps: readonly Step[], final = text): { notes: Note[]; reply: string } {
  let notes: Note[] = []
  let from = 0
  for (const [i, s] of steps.entries()) {
    if (typeof s.at !== 'number' || s.at < from) continue
    const note = text.slice(from, Math.min(s.at, text.length)).trim()
    if (note) notes.push({ text: note, before: i })
    from = Math.min(s.at, text.length)
  }
  // An engine with no last message of its own hands back everything it streamed.
  const own = final.trim() !== text.trim() ? final.trim() : ''
  const reply = own || text.slice(from).trim() || (notes.pop()?.text ?? '')
  if (own) notes = notes.filter((n) => n.text !== reply)
  return { notes, reply }
}

/** A turn waiting its turn: enough to start it again after a restart. */
export interface QueuedTurn {
  id: string
  source: Source
  prompt: string
  userMessageId?: string
  /** Upload ids of the files sent with it. */
  attachmentIds?: string[]
  events?: FleetEvent[]
}

export interface ChatSummary {
  id: string
  title: string
  model: string
  agent?: import('./models.ts').Agent
  updatedAt: string
  preview: string
  where?: Where
}

export function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
}

export function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
}

/** Claude Code's name for each mode chip choice. "ask" is the CLI's "manual" (ask before each action). */
export function cliPermissionMode(mode: Mode): string {
  return mode === 'ask' ? 'manual' : mode
}

/** A chat is titled by its first message, cut to fit a list row. */
export function titleFrom(text: string, max = 48): string {
  const line = text.trim().split('\n')[0]!.trim().replace(/\s+/g, ' ')
  if (!line) return 'New chat'
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** The one cheap call that names a chat after its first exchange. */
export function titleRequest(question: string, answer: string): { system: string; prompt: string } {
  return {
    system: 'Name this conversation in 2 to 5 words, like a short chat title. Reply with the title only: no quotes, no full stop.',
    prompt: `User: ${question.slice(0, 2000)}\n\nAssistant: ${answer.slice(0, 2000)}`,
  }
}

/** A model's title, tidied: first line, no quotes or label or trailing stop, at most 5 words. Null if unusable. */
export function cleanTitle(raw: string): string | null {
  const line = raw.trim().split('\n')[0]!.trim()
    .replace(/^(title|chat title)\s*:\s*/i, '')
    .replace(/^["'“‘*`]+|["'”’*`]+$/g, '')
    .replace(/[.!。]+$/, '')
    .trim()
  const words = line.split(/\s+/).filter(Boolean)
  if (!words.length) return null
  return titleFrom(words.slice(0, 5).join(' '), 48)
}

export function summarize(chat: Chat): ChatSummary {
  const last = [...chat.messages].reverse().find((m) => m.role === 'assistant' || m.role === 'user')
  return {
    id: chat.id,
    title: chat.title,
    model: chat.model,
    ...(chat.agent && chat.agent !== 'claude' ? { agent: chat.agent } : {}),
    updatedAt: chat.updatedAt,
    preview: last ? (last.text || attachmentsLabel(last.attachments ?? [])).replace(/\s+/g, ' ').slice(0, 120) : '',
    ...(chat.where ? { where: chat.where } : {}),
  }
}

/** Keeps the Assistant thread from growing without end; the Claude Code session keeps the real context. */
export function trimThread(messages: Message[], max = 400): Message[] {
  return messages.length > max ? messages.slice(messages.length - max) : messages
}

/** One plain line for a tool call: the command, the file, the pattern or the URL. */
export function stepFor(tool: string, input: Record<string, unknown> | undefined): Step {
  const s = (k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : '')
  const one = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 200)
  let text = ''
  if (tool === 'Bash') text = s('command')
  else if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) text = s('file_path') || s('notebook_path')
  else if (tool === 'Grep' || tool === 'Glob') text = s('pattern')
  else if (tool === 'WebFetch') text = s('url')
  else if (tool === 'WebSearch') text = s('query')
  else if (tool === 'Agent' || tool === 'Task') text = s('description')
  else if (tool === 'Skill') text = s('skill')
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  const name = mcp ? `${mcp[1]} · ${mcp[2]}` : tool
  return { tool: name, text: one(text), label: activityLabel(tool, input) }
}

const base = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p

/** One short present-tense line for a tool call, like Claude Code shows while it works. */
export function activityLabel(tool: string, input: Record<string, unknown> | undefined): string {
  const s = (k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : '')
  const cut = (t: string, n = 48) => {
    const one = t.replace(/\s+/g, ' ').trim()
    return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `Using ${mcp[1]}`
  switch (tool) {
    case 'Bash': {
      // Never the command itself: it is plumbing. The tool's own plain-words description says what it does.
      const cmd = s('command')
      if (/\bagent-session\b(?!-)|\bfleet start\b/.test(cmd)) return 'Starting a worker'
      if (/\bagent-session-forget\b|\bfleet stop\b/.test(cmd)) return 'Stopping a worker'
      return s('description').trim() ? cut(s('description')) : 'Running a command'
    }
    case 'Read': return `Reading ${base(s('file_path'))}`
    case 'Edit': case 'Write': case 'NotebookEdit': return `Editing ${base(s('file_path') || s('notebook_path'))}`
    case 'Grep': return 'Searching files'
    case 'Glob': return 'Finding files'
    case 'WebFetch': {
      try {
        return `Reading ${new URL(s('url')).host}`
      } catch {
        return 'Reading a web page'
      }
    }
    case 'WebSearch': return `Searching the web for ${cut(s('query'), 32)}`
    case 'Agent': case 'Task': return s('description') ? `Asking a helper to ${cut(s('description'), 36).replace(/^./, (c) => c.toLowerCase())}` : 'Asking a helper'
    case 'Skill': return `Using the ${s('skill')} skill`
    case 'TodoWrite': return 'Planning'
    default: return `Using ${tool}`
  }
}

/**
 * The single muted line a turn shows ("Running", "Ran 2 commands"). Never a stack of pills.
 * Empty when the turn used no tools and is finished.
 */
export function statusLine(steps: readonly Step[], running: boolean): string {
  if (running) return 'Running'
  if (steps.length === 0) return ''
  const commands = steps.filter((s) => s.tool === 'Bash').length
  const edits = steps.filter((s) => ['Edit', 'Write', 'NotebookEdit'].includes(s.tool)).length
  const reads = steps.filter((s) => ['Read', 'Grep', 'Glob'].includes(s.tool)).length
  const other = steps.length - commands - edits - reads
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const parts: string[] = []
  if (commands) parts.push(`ran ${n(commands, 'command', 'commands')}`)
  if (edits) parts.push(`edited ${n(edits, 'file', 'files')}`)
  if (reads) parts.push(`read ${n(reads, 'file', 'files')}`)
  if (other) parts.push(`used ${n(other, 'tool', 'tools')}`)
  const line = parts.join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

const QUIET = /^\s*\[quiet\]\s*/i

/** Strips the assistant's [quiet] marker. */
export function readQuiet(raw: string): { text: string; quiet: boolean } {
  return { text: raw.replace(QUIET, '').trim(), quiet: QUIET.test(raw) }
}

const TAGS_AT_START = /^([ \t]*)(\[(?:quiet|needs you)\][ \t]*)+/i

/**
 * The assistant's "[quiet]" / "[needs you]" tags where a paragraph starts, as when it writes several
 * updates in one turn and tags the later ones too. Only the leading tag means anything (readQuiet,
 * readNeeds); the rest are dropped so they never show. Code blocks, and tags inside a sentence, stay.
 * public/live-turn.js does the same to the text while it streams.
 */
export function dropTags(text: string): string {
  const out: string[] = []
  let fenced = false
  let starts = true
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const bare: string = !fenced && starts ? line.replace(TAGS_AT_START, '$1') : line
    // A tag on a line of its own: the paragraph starts on the next line.
    if (bare !== line && !bare.trim()) continue
    out.push(bare)
    starts = !line.trim()
  }
  return out.join('\n')
}

/**
 * Where a running turn's reply goes in the thread: above the messages still waiting their turn (sent
 * while it ran), so what was already on screen keeps its order. At the end when nothing waits.
 */
export function replySlot(messages: readonly Message[], waiting: readonly string[]): number {
  const i = messages.findIndex((m) => waiting.includes(m.id))
  return i < 0 ? messages.length : i
}

/** The TL;DR line without its label and Markdown, or the first non-empty line, cut to fit a notification. */
export function notificationText(text: string, max = 160): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const tldr = lines.find((l) => /^\**\s*TL;DR:?/i.test(l))
  const line = (tldr ?? lines[0] ?? '')
    .replace(/^\**\s*TL;DR:?\s*\**\s*:?\s*/i, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/, '')
    .trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/**
 * A chat moved to another agent (Claude Code to Codex, or back), which has no session for it: the new
 * agent's first prompt carries the conversation so far, newest last, each message cut to fit.
 */
export function handoverPrompt(history: readonly Message[], prompt: string, from: string, max = 40, each = 4000): string {
  const said = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .slice(-max)
    .map((m) => {
      const text = m.text.length > each ? `${m.text.slice(0, each)}…` : m.text
      return `${m.role === 'user' ? 'User' : from}: ${text}`
    })
  if (!said.length) return prompt
  return [
    `(This conversation was with ${from} until now; you're taking over. What was said so far:)`,
    ...said,
    '(End of the conversation so far. The new message:)',
    prompt,
  ].join('\n\n')
}
