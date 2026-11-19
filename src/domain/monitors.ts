// Monitors: recurring, unattended agent jobs. Each one has instructions, an optional agent to run as, a
// folder and a trigger: a schedule ("every 30 min", "daily 21:00", "weekdays 07:30") or a check (a cheap
// shell command run every N minutes; the job runs when the check's output changes). Pure rules only.

/** Every N minutes, or at a time of day on some days of the week (0 = Sunday), in this computer's time zone. */
export type ScheduleSpec = { every: number } | { at: string; days: number[] }

export interface CheckSpec {
  command: string
  /** How often the command runs, in minutes. */
  every: number
}

export type Trigger =
  | { kind: 'schedule'; text: string; spec: ScheduleSpec }
  | { kind: 'check'; text: string; spec: CheckSpec }

export type RunStatus = 'running' | 'ok' | 'failed' | 'needs-you' | 'skipped'

export interface MonitorRun {
  id: string
  status: RunStatus
  startedAt: string
  endedAt: string | null
  summary: string
  /** What started it: its schedule, its check, or "run now". */
  reason?: 'schedule' | 'check' | 'manual'
  /** A run still going in a process that outlives the hub: how to pick it up after a restart. */
  handle?: string
}

export interface Monitor {
  id: string
  name: string
  instructions: string
  /** The agent it runs as ("apologist"), or null for none. */
  agent: string | null
  cwd: string
  trigger: Trigger
  enabled: boolean
  createdAt: string
  /** When the schedule fires next, or the check runs next; null while paused. */
  nextRunAt: string | null
  /** A check's last output (a hash), so a change can be seen across restarts. */
  lastCheck?: string | null
  /** Newest first, at most MAX_RUNS. */
  runs: MonitorRun[]
}

export const MAX_RUNS = 50
/** Checks can't run more often than this (minutes). */
export const MIN_CHECK_EVERY = 1
const FULL_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKENDS = [0, 6]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/** "30 min", "2 hours", "1h", "90m", "hour" -> minutes, or null. */
export function parseMinutes(text: string): number | null {
  const t = text.trim().toLowerCase()
  if (/^(an? )?hour$/.test(t)) return 60
  if (/^(a )?(minute|min)$/.test(t)) return 1
  if (/^(a )?day$/.test(t)) return 1440
  const m = /^(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/.exec(t)
  if (!m) return /^\d+$/.test(t) ? Number(t) || null : null
  const n = Number(m[1])
  const unit = m[2]![0]
  const minutes = Math.round(unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n)
  return minutes > 0 ? minutes : null
}

/** "21:00", "9pm", "7:30am", "07.30" -> "HH:MM", or null. */
export function parseTime(text: string): string | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(text.trim().toLowerCase())
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (!m[2] && !m[3]) return null // a bare "9" is too vague
  if (m[3]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0)
  }
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** "weekdays", "mon,wed,fri", "mondays", "daily" -> days of the week, or null. */
function parseDays(text: string): number[] | null {
  const t = text.trim().toLowerCase().replace(/^on\s+/, '').replace(/^(every|each)\s+/, '')
  if (['', 'daily', 'day', 'every day', 'everyday'].includes(t)) return EVERY_DAY
  if (/^week ?days?$/.test(t)) return WEEKDAYS
  if (/^week ?ends?$/.test(t)) return WEEKENDS
  const days = new Set<number>()
  for (const part of t.split(/\s*(?:,|\band\b|&|\s)\s*/).filter(Boolean)) {
    const range = /^([a-z]+)-([a-z]+)$/.exec(part)
    if (range) {
      const a = dayOf(range[1]!)
      const b = dayOf(range[2]!)
      if (a === null || b === null) return null
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d)
        if (d === b) break
      }
      continue
    }
    const d = dayOf(part)
    if (d === null) return null
    days.add(d)
  }
  return days.size ? [...days].sort((a, b) => a - b) : null
}

/** "mon", "monday", "mondays", "tues", "thurs" -> 1, 1, 1, 2, 4; null for anything else. */
function dayOf(word: string): number | null {
  if (word.length < 3) return null
  const i = FULL_DAYS.findIndex((d) => d.startsWith(word) || `${d}s` === word || (word === 'weds' && d === 'wednesday'))
  return i >= 0 ? i : null
}

/**
 * A schedule in plain words: "every 30 min", "every 2 hours", "hourly", "daily 21:00", "every day at 9pm",
 * "weekdays 07:30", "weekends at 10am", "mon,wed,fri 08:00", "mondays 9:00". Null when it can't be read.
 */
export function parseSchedule(text: string): ScheduleSpec | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (t === 'hourly') return { every: 60 }
  const every = /^every (.+)$/.exec(t)
  if (every) {
    const minutes = parseMinutes(every[1]!)
    if (minutes) return { every: minutes }
  }
  // "<days> [at] <time>" or "<time> <days>"
  const m = /^(.*?)\s*(?:at\s+)?(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)$/.exec(t)
  if (m) {
    const at = parseTime(m[2]!)
    const days = parseDays(m[1]!.replace(/\s+at$/, ''))
    if (at && days) return { at, days }
  }
  const lead = /^(?:at\s+)?(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s+(.+)$/.exec(t)
  if (lead) {
    const at = parseTime(lead[1]!)
    const days = parseDays(lead[2]!)
    if (at && days) return { at, days }
  }
  return null
}

/** "30 min", "2 hours", "1 h 30 min" for showing. */
export function minutesText(n: number): string {
  if (n % 1440 === 0) return n === 1440 ? 'day' : `${n / 1440} days`
  if (n % 60 === 0) return n === 60 ? 'hour' : `${n / 60} hours`
  if (n > 60) return `${Math.floor(n / 60)} h ${n % 60} min`
  return `${n} min`
}

/** The schedule as people say it: "Every 30 min", "Daily at 21:00", "Weekdays at 07:30", "Mon, Fri at 08:00". */
export function scheduleText(spec: ScheduleSpec): string {
  if ('every' in spec) return `Every ${minutesText(spec.every)}`
  const d = spec.days.join(',')
  const days = d === EVERY_DAY.join(',') ? 'Daily' : d === WEEKDAYS.join(',') ? 'Weekdays' : d === WEEKENDS.join(',') ? 'Weekends' : spec.days.map((x) => LABELS[x]).join(', ')
  return `${days} at ${spec.at}`
}

export function checkText(spec: CheckSpec): string {
  const cmd = spec.command.length > 60 ? `${spec.command.slice(0, 59)}…` : spec.command
  return `When \`${cmd}\` changes (checked every ${minutesText(spec.every)})`
}

/**
 * A trigger from what the Assistant or the app sent: a schedule as text ("daily 21:00"), or
 * { kind: 'schedule', text } / { kind: 'check', command, every } ("every" in minutes or words, default 10 min).
 * Throws a plain sentence when it can't be read.
 */
export function triggerFrom(v: unknown): Trigger {
  const o = (typeof v === 'string' ? { kind: 'schedule', text: v } : v) as Record<string, unknown> | null
  if (!o || typeof o !== 'object') throw new Error('Give a trigger: a schedule like "every 30 min" or "daily 21:00", or a check')
  if (o.kind === 'check') {
    const command = typeof o.command === 'string' ? o.command.trim() : ''
    if (!command) throw new Error('A check needs a command to run')
    if (command.length > 2000) throw new Error('The check command is too long')
    const every = typeof o.every === 'number' ? Math.round(o.every) : typeof o.every === 'string' ? parseMinutes(o.every.replace(/^every\s+/i, '')) : 10
    if (!every || every < MIN_CHECK_EVERY || every > 7 * 1440) throw new Error('Check every 1 minute to 7 days, like "10 min"')
    const spec = { command, every }
    return { kind: 'check', text: checkText(spec), spec }
  }
  const text = typeof o.text === 'string' ? o.text : ''
  const spec = parseSchedule(text)
  if (!spec) throw new Error(`Can't read "${text.slice(0, 80)}" as a schedule; try "every 30 min", "daily 21:00" or "weekdays 07:30"`)
  if ('every' in spec && (spec.every < 1 || spec.every > 30 * 1440)) throw new Error('Run every 1 minute to 30 days')
  return { kind: 'schedule', text: scheduleText(spec), spec }
}

/** When a schedule fires next after `after` (this computer's time zone). */
export function nextScheduled(spec: ScheduleSpec, after: Date): Date {
  if ('every' in spec) return new Date(after.getTime() + spec.every * 60_000)
  const [h, m] = spec.at.split(':').map(Number) as [number, number]
  for (let i = 0; i <= 7; i++) {
    const d = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, h, m, 0, 0)
    if (d.getTime() > after.getTime() && spec.days.includes(d.getDay())) return d
  }
  return new Date(after.getTime() + 7 * 86_400_000) // unreachable with at least one day
}

/** When the trigger is next due after `after`: the schedule's next time, or the check's next look. */
export function nextDue(trigger: Trigger, after: Date): Date {
  return trigger.kind === 'check' ? new Date(after.getTime() + trigger.spec.every * 60_000) : nextScheduled(trigger.spec, after)
}

/** A short, unique id from the name: "Bible study" -> "bible-study". */
export function monitorId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'monitor'
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`
  return id
}

/** Told to the agent on every run, on top of its own instructions. */
export function monitorNote(name: string): string {
  return [
    `You are running unattended as the monitor "${name}", a recurring job the user set up in Limeade. Nobody is watching this run and nobody can answer questions or approve anything during it.`,
    'Do the job, then end your reply with exactly one last line:',
    '`SUMMARY: <one plain line on what happened>` when it went fine,',
    '`NEEDS-YOU: <what the user must decide or do>` when something needs them,',
    'or `FAILED: <why>` when it could not be done.',
  ].join(' ')
}

/** The run's outcome and one-line summary from the agent's reply. */
export function runOutcome(reply: string, error: string | undefined, askedApproval: boolean): { status: 'ok' | 'failed' | 'needs-you'; summary: string } {
  const lines = reply.split('\n').map((l) => l.trim()).filter(Boolean)
  const tagged = (tag: string) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = new RegExp(`^\\W{0,3}${tag}\\W{0,3}:\\s*(.*)$`, 'i').exec(lines[i]!)
      if (m) return clip(m[1]!.replace(/^[*_`\s]+|[*_`\s]+$/g, ''))
    }
    return null
  }
  if (error) return { status: 'failed', summary: clip(error) }
  const failed = tagged('FAILED')
  if (failed !== null) return { status: 'failed', summary: failed || 'Failed' }
  const needs = tagged('NEEDS-YOU')
  if (needs !== null) return { status: 'needs-you', summary: needs || 'Needs you' }
  const summary = tagged('SUMMARY') ?? clip(lines.at(-1)?.replace(/^[#>*\-\s]+/, '') ?? '')
  if (askedApproval) return { status: 'needs-you', summary: `It wanted an approval nobody could give. ${summary}`.trim() }
  return { status: 'ok', summary: summary || 'Done' }
}

function clip(s: string, max = 200): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** The run the list shows: the one going now, else the newest. */
export function lastRun(m: Monitor): MonitorRun | null {
  return m.runs.find((r) => r.status === 'running') ?? m.runs[0] ?? null
}

/** Adds a run at the front and keeps the newest MAX_RUNS; returns the ones dropped (their logs go too). */
export function addRun(m: Monitor, run: MonitorRun): MonitorRun[] {
  m.runs.unshift(run)
  return m.runs.length > MAX_RUNS ? m.runs.splice(MAX_RUNS) : []
}
