// Workers: the agent sessions the assistant started (~/.claude/agent-sessions.tsv), what they last
// reported (~/.claude/fleet/status/<slug>.status) and their job (~/.claude/fleet/backlog.tsv). Pure rules.

import { activityLabel } from './chat.ts'

/** working: busy now · needs: waiting on the user · idle: sitting at its prompt · done: finished or gone. */
export type WorkerState = 'working' | 'needs' | 'idle' | 'done'

/** What the worker's terminal shows, as ~/bin/fleet reads it. */
export type PaneState = 'busy' | 'idle' | 'prompt' | 'stopped' | 'gone'

export interface Registered {
  /** Claude Code's own session id (its transcript's file name). */
  uuid: string
  remoteId: string
  agent: string
  title: string
  dir: string
  slug: string
}

export interface StatusLine {
  at: string
  state: string // working | paused | needs-decision | blocked | done | failed
  text: string
}

export interface WorkerSummary {
  id: string // the slug
  title: string
  state: WorkerState
  /** Latest status text it reported. */
  now: string
  /** When it last reported (ISO), or null. */
  at: string | null
  /** Its job from the backlog, the row's one-line description. */
  job?: string | null
  /** What it's doing this moment, from its transcript ("Running npm test"); null when idle. */
  activity?: string | null
  /** When it last did anything (ISO): its newest transcript write or report, whichever is later. */
  activeAt?: string | null
  /** The agent it runs as ("developer"), or null for a plain session. */
  agent?: string | null
}

export interface WorkerDetail extends WorkerSummary {
  lines: StatusLine[]
  startedAt: string | null
  machine: string
  model: string
  agent: string
  dir: string
}

/** One line of agent-sessions.tsv: uuid, remote id, agent, title, workdir, slug. */
export function parseRegistry(text: string): Registered[] {
  return text.split('\n').flatMap((line) => {
    const f = line.split('\t')
    if (f.length < 6 || !f[5]) return []
    return [{ uuid: f[0]!, remoteId: f[1]!, agent: f[2]!, title: f[3]!, dir: f[4]!, slug: f[5]! }]
  })
}

/** The agent a worker runs as, or null when it runs as none ("-" or empty in the records). */
export function agentOf(raw: string | null | undefined): string | null {
  const a = raw?.trim() ?? ''
  return a && a !== '-' ? a : null
}

/** "<UTC time> <state>: <text>" lines, oldest first. */
export function parseStatus(text: string): StatusLine[] {
  return text.split('\n').flatMap((line) => {
    const m = /^(\S+) ([a-z-]+): ?(.*)$/.exec(line.trim())
    return m ? [{ at: m[1]!, state: m[2]!, text: m[3]! }] : []
  })
}

/** The newest backlog title whose session column names this worker (backlog: id state session title note updated). */
export function jobFor(backlog: string, title: string): string | null {
  let job: string | null = null
  for (const line of backlog.split('\n')) {
    const f = line.split('\t')
    if (f.length >= 4 && f[2] === title && f[3]) job = f[3]
  }
  return job
}

/**
 * One state per worker. The terminal wins when it shows something waiting on the user or busy work;
 * otherwise the last report decides.
 */
export function workerState(pane: PaneState, last: StatusLine | undefined): WorkerState {
  if (pane === 'gone') return 'done' // no tmux session: an old report can't make it need the user
  if (pane === 'prompt') return 'needs'
  if (last && (last.state === 'needs-decision' || last.state === 'blocked')) return 'needs'
  if (pane === 'busy') return 'working'
  if (pane === 'stopped') return 'done'
  if (last && (last.state === 'done' || last.state === 'failed')) return 'done'
  return 'idle'
}

/** Active = still in the registry with a live tmux session; anything else isn't listed. */
export function isActive(pane: PaneState): boolean {
  return pane !== 'gone'
}

/** Same reading of the terminal as ~/bin/fleet's pane_state. */
export function paneStateFrom(screen: string | null): PaneState {
  if (screen === null) return 'gone'
  const tail = screen.split('\n').filter((l) => l.trim()).slice(-15).join('\n')
  if (/Enter to confirm|Do you want to|Allow this|trust this folder|Enable selected/.test(tail)) return 'prompt'
  if (/esc to interrupt/.test(tail)) return 'busy'
  if (/auto mode on|shift\+tab to cycle|❯/.test(tail)) return 'idle'
  return 'stopped'
}

/** The words a status line's state reads as on a phone. */
export function stateWords(state: string): string {
  return (
    { working: 'Working', paused: 'Paused', 'needs-decision': 'Needs you', blocked: 'Blocked', done: 'Done', failed: 'Failed' } as Record<
      string,
      string
    >
  )[state] ?? state
}

/** The later of two ISO times, either of which may be missing. */
export function latestOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a || !b) return a || b || null
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/** Needs-you first, then working, then idle, then done; most recent activity first within each. */
export function sortWorkers<T extends WorkerSummary>(list: T[]): T[] {
  const rank: Record<WorkerState, number> = { needs: 0, working: 1, idle: 2, done: 3 }
  const when = (w: T) => Date.parse(w.activeAt ?? w.at ?? '') || 0
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || when(b) - when(a))
}

/**
 * The latest thing a worker did, from the end of its Claude Code transcript (JSONL): its last tool call
 * ("Editing app.js"), or "Writing" when its last word was text. Sub-agent lines are skipped.
 */
export function latestActivity(jsonlTail: string): { label: string; at: string | null } | null {
  const lines = jsonlTail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{') || !line.includes('"assistant"')) continue
    let m: any
    try {
      m = JSON.parse(line)
    } catch {
      continue // the first line of a tail is usually cut
    }
    if (m.type !== 'assistant' || m.isSidechain || !Array.isArray(m.message?.content)) continue
    const tools = m.message.content.filter((b: any) => b?.type === 'tool_use')
    const at = typeof m.timestamp === 'string' ? m.timestamp : null
    if (tools.length) return { label: activityLabel(tools.at(-1).name, tools.at(-1).input), at }
    if (m.message.content.some((b: any) => b?.type === 'text' && b.text?.trim())) return { label: 'Writing', at }
  }
  return null
}

/** Claude Code keeps a session's transcript under ~/.claude/projects/<workdir with / and . as ->/<id>.jsonl. */
export function transcriptPath(claudeDir: string, workdir: string, sessionUuid: string): string {
  return `${claudeDir}/projects/${workdir.replace(/[/.]/g, '-')}/${sessionUuid}.jsonl`
}
