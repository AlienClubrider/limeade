// Fleet events (lines of ~/.claude/fleet/events.log) and which assistant acts on them.

/** claude-app: today's setup, fleet-rewake wakes the Claude app assistant. app: this hub's assistant. */
export type FleetMode = 'claude-app' | 'app'
export const DEFAULT_FLEET_MODE: FleetMode = 'claude-app'

/** Anything other than an exact "app" keeps today's setup. */
export function parseFleetMode(raw: string | null | undefined): FleetMode {
  return raw?.trim() === 'app' ? 'app' : DEFAULT_FLEET_MODE
}

export function isFleetMode(v: unknown): v is FleetMode {
  return v === 'claude-app' || v === 'app'
}

export interface FleetEvent {
  seq: number
  at: string
  slug: string
  kind: string
  text: string
  line: string
}

/** "<seq> <time> <slug> <kind>: <text>" as written by fleet-watch. */
export function parseEventLine(line: string): FleetEvent | null {
  const m = /^(\d+) (\S+) (\S+) ([^:]+?): ?(.*)$/.exec(line.trim())
  if (!m) return null
  return { seq: Number(m[1]), at: m[2]!, slug: m[3]!, kind: m[4]!, text: m[5]!, line: line.trim() }
}

/** Same rule as the fleet-rewake hook: an event wakes an assistant once, after both the ack cursor and the last wake. */
export function eventsToWake(lines: readonly string[], cursor: number, lastWake: number): FleetEvent[] {
  const floor = Math.max(cursor, lastWake)
  return lines.map(parseEventLine).filter((e): e is FleetEvent => e !== null && e.seq > floor)
}

/** Worded like the Stop hook's wake-up so the assistant handles it the same way. */
export function wakeMessage(events: readonly FleetEvent[], ack: string): string {
  return [`[fleet event] Fleet events (handle each, then ${ack}):`, ...events.map((e) => e.line)].join('\n')
}

/** The worker's state when it reported one ("done", "needs-decision", …), else the event kind. */
export function eventState(e: FleetEvent): string {
  if (e.kind === 'reported') return /^([a-z-]+):/.exec(e.text)?.[1] ?? 'reported'
  return e.kind
}

/** "shop-pack-sizes" -> "Shop pack sizes"; a "cc-" prefix is dropped. */
export function workerName(slug: string): string {
  const words = slug.replace(/^cc-/, '').split('-').filter(Boolean).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Short marker shown in the thread for each event. */
export function eventMarker(e: FleetEvent): string {
  return `${workerName(e.slug)} · ${eventState(e).replace('-', ' ')}`
}

export type NoticeKind = 'done' | 'needs' | 'approval' | 'reply'

/** Does a batch of events need the user, or is it news? Drives which notification toggle applies. */
export function noticeKindFor(events: readonly FleetEvent[]): NoticeKind {
  const needs = events.some((e) => ['needs-decision', 'blocked', 'failed', 'prompt'].includes(eventState(e)))
  return needs ? 'needs' : 'done'
}

/** Notification heading for a fleet-event turn, like "Recipes dark theme needs you". */
export function noticeTitle(events: readonly FleetEvent[]): string {
  if (events.length === 0) return 'Assistant'
  const first = events.find((e) => noticeKindFor([e]) === 'needs') ?? events.at(-1)!
  const verb = noticeKindFor([first]) === 'needs' ? 'needs you' : eventState(first) === 'done' ? 'is done' : 'update'
  const more = events.length > 1 ? ` (+${events.length - 1})` : ''
  return `${workerName(first.slug)} ${verb}${more}`
}

/** A new worker's name in fleet records: its title in lowercase words ("Dark theme" -> "dark-theme"), unique. */
export function workerSlug(title: string, taken: ReadonlySet<string>): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'worker'
  let slug = base
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`
  return slug
}
