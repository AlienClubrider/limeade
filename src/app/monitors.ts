// Monitors: recurring, unattended agent jobs the Assistant sets up. Each firing runs one agent turn (no
// chat, nobody to approve anything) and keeps its outcome, a one-line summary and the full log. Runs that
// fail or need the user become fleet events, the same news the Assistant gets about its workers; runs that
// went fine stay quiet. The schedule lives in the monitor's file, so a restarted hub carries on from it.

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  addRun, lastRun, monitorId, monitorNote, nextDue, runOutcome, triggerFrom,
  type Monitor, type MonitorRun, type Trigger,
} from '../domain/monitors.ts'
import type { CheckRunner, EngineEvent, FleetRecords, MonitorStore, MonitorTurn, MonitorTurns, TurnResult } from '../ports.ts'
import { HubError } from './conversations.ts'

interface Deps {
  store: MonitorStore
  turns: MonitorTurns
  checks: CheckRunner
  /** Where failed and needs-you runs are reported (the fleet events the Assistant reads). */
  news: Pick<FleetRecords, 'addEvent'>
  /** The real path of a folder under home, or null. */
  resolveFolder: (path: string) => Promise<string | null>
  defaultFolder: string
  /** Whether an agent ("apologist") exists to run as. */
  hasAgent?: (name: string) => Promise<boolean>
  now?: () => number
  log?: (line: string) => void
}

/** A run going now: how to stop it and what it has said so far. */
interface Live {
  runId: string
  ctl: AbortController
  /** The log so far: the reply's text with each step on its own line. */
  log: string
  askedApproval: boolean
}

export type RunView = Omit<MonitorRun, 'handle'>

export interface MonitorSummary {
  id: string
  name: string
  /** One plain line on what it does; '' when none was given. */
  description: string
  agent: string | null
  trigger: Trigger
  enabled: boolean
  nextRunAt: string | null
  lastRun: RunView | null
}

export interface MonitorDetail extends MonitorSummary {
  instructions: string
  cwd: string
  createdAt: string
  runs: RunView[]
}

const DECLINED = 'This is an unattended monitor run: nobody can approve this. Do without it, or end with a NEEDS-YOU: line saying what you needed.'

/**
 * Events: 'monitors' {id} whenever a monitor or one of its runs changes.
 */
export class Monitors extends EventEmitter {
  private d: Deps
  private all = new Map<string, Monitor>()
  private live = new Map<string, Live>()
  private checking = new Set<string>()
  private ticking = false
  private nudge: ReturnType<typeof setTimeout> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(d: Deps) {
    super()
    this.d = d
  }

  private now() {
    return this.d.now?.() ?? Date.now()
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString()
  }

  /** Reads the monitors; runs an earlier hub left going are picked up again, or marked as cut off. */
  async load(): Promise<void> {
    for (const m of await this.d.store.list()) {
      this.all.set(m.id, m)
      if (m.enabled && !m.nextRunAt) m.nextRunAt = this.iso(nextDue(m.trigger, new Date(this.now())).getTime())
      for (const run of m.runs.filter((r) => r.status === 'running')) {
        if (run.handle && !this.live.has(m.id)) this.execute(m, run, '', run.handle)
        else await this.finish(m, run, { status: 'failed', summary: 'The hub restarted during this run' }, '')
      }
    }
  }

  /** Looks for due monitors every `everyMs` (default 15 s). */
  start(everyMs = 15_000): void {
    this.timer ??= setInterval(() => void this.tick().catch((err) => this.say(`monitors: ${(err as Error).message}`)), everyMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private say(line: string) {
    ;(this.d.log ?? console.log)(line)
  }

  /** Fires every monitor that is due: a schedule whose time came, a check whose output changed. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      const checks: Promise<void>[] = []
      for (const m of this.all.values()) {
        if (!m.enabled || !m.nextRunAt || Date.parse(m.nextRunAt) > now) continue
        // A run missed while the hub was off happens once, now; the next one counts from now.
        m.nextRunAt = this.iso(nextDue(m.trigger, new Date(now)).getTime())
        if (m.trigger.kind === 'check') checks.push(this.check(m))
        else await this.fire(m, 'schedule')
        await this.save(m)
      }
      await Promise.all(checks)
    } finally {
      this.ticking = false
    }
  }

  /** Runs the check; the job runs when its output differs from last time (the first look only records it). */
  private async check(m: Monitor): Promise<void> {
    if (m.trigger.kind !== 'check' || this.checking.has(m.id)) return
    this.checking.add(m.id)
    try {
      const { command } = m.trigger.spec
      const r = await this.d.checks.run(command, m.cwd)
      if (r.error) return this.say(`monitor ${m.id}: check didn't run: ${r.error}`)
      const hash = createHash('sha256').update(r.output).digest('hex')
      const before = m.lastCheck
      if (before === hash || !this.all.has(m.id)) return
      m.lastCheck = hash
      if (before) await this.fire(m, 'check', `The check \`${command}\` now prints:\n${r.output.slice(0, 4000) || '(nothing)'}`)
      await this.save(m)
    } finally {
      this.checking.delete(m.id)
    }
  }

  /** Starts a run, or notes a skipped one when the last is still going. */
  private async fire(m: Monitor, reason: 'schedule' | 'check' | 'manual', context = ''): Promise<MonitorRun> {
    const going = this.live.get(m.id)
    if (going) {
      const since = m.runs.find((r) => r.id === going.runId)?.startedAt
      const skipped: MonitorRun = { id: randomUUID().slice(0, 8), status: 'skipped', startedAt: this.iso(), endedAt: this.iso(), summary: `Skipped: the last run was still going${since ? ` (since ${since})` : ''}`, reason }
      await this.keep(m, skipped)
      return skipped
    }
    const run: MonitorRun = { id: randomUUID().slice(0, 8), status: 'running', startedAt: this.iso(), endedAt: null, summary: 'Running', reason }
    await this.keep(m, run)
    this.execute(m, run, context ? `${m.instructions}\n\n${context}` : m.instructions)
    return run
  }

  /** Adds a run to the monitor's history (dropping the oldest past 50, with their logs). */
  private async keep(m: Monitor, run: MonitorRun) {
    for (const old of addRun(m, run)) await this.d.store.removeLog(m.id, old.id).catch(() => undefined)
    await this.save(m)
  }

  /** Runs the turn (or follows one an earlier hub started) to its end, then records how it went. */
  private execute(m: Monitor, run: MonitorRun, prompt: string, handle?: string): void {
    const live: Live = { runId: run.id, ctl: new AbortController(), log: '', askedApproval: false }
    this.live.set(m.id, live)
    const t: MonitorTurn = {
      prompt,
      cwd: m.cwd,
      agent: m.agent,
      note: monitorNote(m.name),
      signal: live.ctl.signal,
      onEvent: (e) => this.onEvent(live, e),
      onStart: (h) => {
        run.handle = h
        void this.save(m).catch(() => undefined)
      },
    }
    void (async () => {
      let result: TurnResult | null
      try {
        result = handle ? await this.d.turns.reattach(handle, t) : await this.d.turns.run(t)
      } catch (err) {
        result = { text: '', sessionId: null, error: (err as Error).message }
      }
      if (!result) result = { text: '', sessionId: null, error: 'The hub restarted during this run and it could not be picked up' }
      if (live.ctl.signal.aborted && !result.error) result.error = 'Stopped'
      // Engines that don't stream still hand back the reply.
      if (!live.log.trim() && result.text) live.log = result.text
      const outcome = runOutcome(result.text || live.log, result.error, live.askedApproval)
      const log = result.error ? `${live.log}\n\n${result.error}`.trim() : live.log
      if (this.live.get(m.id) === live) this.live.delete(m.id)
      await this.finish(m, run, outcome, log)
    })().catch((err) => this.say(`monitor ${m.id}: ${(err as Error).message}`))
  }

  private onEvent(live: Live, e: EngineEvent) {
    if (e.type === 'text') live.log += e.text
    else if (e.type === 'step') live.log += `\n› ${e.step.label ?? `${e.step.tool} ${e.step.text}`.trim()}\n`
    else if (e.type === 'resumed') live.log = e.text + e.steps.map((s) => `\n› ${s.label ?? s.tool}`).join('')
    else if (e.type === 'approval') {
      live.askedApproval = true
      live.log += `\n› Wanted approval for ${e.request.text || e.request.tool} (declined: nobody to ask)\n`
      e.answer('no', DECLINED)
    } else return
    // The detail page reads the log as it grows; tell it now and then, not on every step.
    if (e.type !== 'text' && !this.nudge) {
      this.nudge = setTimeout(() => {
        this.nudge = null
        this.emit('monitors', { id: null })
      }, 2000)
      this.nudge.unref?.()
    }
  }

  private async finish(m: Monitor, run: MonitorRun, outcome: { status: MonitorRun['status']; summary: string }, log: string) {
    run.status = outcome.status
    run.summary = outcome.summary
    run.endedAt = this.iso()
    delete run.handle
    if (!this.all.has(m.id)) return // deleted while it ran
    await this.d.store.writeLog(m.id, run.id, log)
    await this.save(m)
    if (run.status === 'failed' || run.status === 'needs-you') {
      const state = run.status === 'failed' ? 'failed' : 'needs-decision'
      await this.d.news.addEvent(`monitor-${m.id}`, 'reported', `${state}: monitor "${m.name}": ${run.summary}`).catch((err) => this.say(`monitor ${m.id}: couldn't report: ${(err as Error).message}`))
    }
  }

  private async save(m: Monitor) {
    if (!this.all.has(m.id)) return
    await this.d.store.save(m)
    this.emit('monitors', { id: m.id })
  }

  // ---------- what the API and CLI see ----------

  private find(id: string): Monitor {
    const m = this.all.get(id)
    if (!m) throw new HubError(404, 'No such monitor')
    return m
  }

  private summary(m: Monitor): MonitorSummary {
    const last = lastRun(m)
    return { id: m.id, name: m.name, description: m.description ?? '', agent: m.agent, trigger: m.trigger, enabled: m.enabled, nextRunAt: m.enabled ? m.nextRunAt : null, lastRun: last && view(last) }
  }

  list(): MonitorSummary[] {
    return [...this.all.values()].sort((a, b) => a.name.localeCompare(b.name)).map((m) => this.summary(m))
  }

  get(id: string): MonitorDetail {
    const m = this.find(id)
    return { ...this.summary(m), instructions: m.instructions, cwd: m.cwd, createdAt: m.createdAt, runs: m.runs.map(view) }
  }

  async runLog(id: string, runId: string): Promise<RunView & { log: string }> {
    const m = this.find(id)
    const run = m.runs.find((r) => r.id === runId)
    if (!run) throw new HubError(404, 'No such run')
    const live = this.live.get(id)
    const log = live?.runId === runId ? live.log : (await this.d.store.readLog(id, runId)) ?? ''
    return { ...view(run), log }
  }

  async create(b: Record<string, unknown>): Promise<MonitorDetail> {
    const name = this.name(b.name)
    const at = this.iso()
    const trigger = this.trigger(b.trigger)
    const enabled = b.enabled === undefined ? true : this.bool(b.enabled)
    const m: Monitor = {
      id: monitorId(name, new Set(this.all.keys())),
      name,
      description: this.description(b.description),
      instructions: this.instructions(b.instructions),
      agent: await this.agent(b.agent),
      cwd: await this.folder(b.cwd ?? this.d.defaultFolder),
      trigger,
      enabled,
      createdAt: at,
      nextRunAt: enabled ? this.iso(nextDue(trigger, new Date(this.now())).getTime()) : null,
      lastCheck: null,
      runs: [],
    }
    this.all.set(m.id, m)
    await this.save(m)
    return this.get(m.id)
  }

  /** Changes any of name, description, instructions, agent, cwd, trigger, enabled. */
  async update(id: string, b: Record<string, unknown>): Promise<MonitorDetail> {
    const m = this.find(id)
    const next: Monitor = { ...m }
    if (b.name !== undefined) next.name = this.name(b.name)
    if (b.description !== undefined) next.description = this.description(b.description)
    if (b.instructions !== undefined) next.instructions = this.instructions(b.instructions)
    if (b.agent !== undefined) next.agent = await this.agent(b.agent)
    if (b.cwd !== undefined) next.cwd = await this.folder(b.cwd)
    if (b.trigger !== undefined) {
      next.trigger = this.trigger(b.trigger)
      if (next.trigger.kind !== 'check' || m.trigger.kind !== 'check' || next.trigger.spec.command !== m.trigger.spec.command) next.lastCheck = null
    }
    if (b.enabled !== undefined) next.enabled = this.bool(b.enabled)
    if (!next.enabled) next.nextRunAt = null
    else if (b.trigger !== undefined || !m.enabled || !m.nextRunAt) next.nextRunAt = this.iso(nextDue(next.trigger, new Date(this.now())).getTime())
    Object.assign(m, next)
    await this.save(m)
    return this.get(id)
  }

  /** Deletes it with its history; a run going now is stopped. */
  async remove(id: string): Promise<void> {
    this.find(id)
    this.all.delete(id)
    this.live.get(id)?.ctl.abort()
    this.live.delete(id)
    await this.d.store.remove(id)
    this.emit('monitors', { id, deleted: true })
  }

  /** Runs it now, paused or not; 409 while a run is going. */
  async runNow(id: string): Promise<RunView> {
    const m = this.find(id)
    if (this.live.has(id)) throw new HubError(409, 'It is running already')
    return view(await this.fire(m, 'manual'))
  }

  // ---------- checking what was sent ----------

  private name(v: unknown): string {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
    if (!s) throw new HubError(400, 'Give the monitor a name')
    if (s.length > 80) throw new HubError(400, 'Keep the name under 80 characters')
    return s
  }

  /** Optional: one line, spaces tidied; empty or missing means none. */
  private description(v: unknown): string {
    if (v === undefined || v === null) return ''
    if (typeof v !== 'string') throw new HubError(400, 'The description must be text')
    const s = v.replace(/\s+/g, ' ').trim()
    if (s.length > 200) throw new HubError(400, 'Keep the description to one short line (under 200 characters)')
    return s
  }

  private instructions(v: unknown): string {
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s) throw new HubError(400, 'The instructions are empty')
    if (s.length > 20_000) throw new HubError(400, 'The instructions are too long')
    return s
  }

  private trigger(v: unknown): Trigger {
    try {
      return triggerFrom(v)
    } catch (err) {
      throw new HubError(400, (err as Error).message)
    }
  }

  private bool(v: unknown): boolean {
    if (typeof v !== 'boolean') throw new HubError(400, 'enabled must be true or false')
    return v
  }

  private async agent(v: unknown): Promise<string | null> {
    if (v === null) return null
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s || s === '-') return null
    if (!/^[\w.-]{1,64}$/.test(s)) throw new HubError(400, 'Not an agent name')
    if (this.d.hasAgent && !(await this.d.hasAgent(s))) throw new HubError(400, `There's no agent named ${s}; use one from the Agents page, or none`)
    return s
  }

  private async folder(v: unknown): Promise<string> {
    const path = typeof v === 'string' ? v.trim() : ''
    const real = path ? await this.d.resolveFolder(path) : null
    if (!real) throw new HubError(400, 'That folder doesn’t exist in your home folder')
    return real
  }
}

function view(r: MonitorRun): RunView {
  const { handle: _h, ...rest } = r
  return rest
}
