// Reads workers from the fleet records and their tmux panes, and stops one the way the assistant does
// (~/bin/agent-session-forget: kill the pane, drop it from the restore list).

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { claudeLabel } from '../domain/models.ts'
import {
  isActive, jobFor, latestActivity, latestOf, paneStateFrom, parseRegistry, parseStatus, sortWorkers, transcriptPath, workerState,
  type Registered, type WorkerDetail, type WorkerSummary,
} from '../domain/workers.ts'
import type { WorkerSource } from '../ports.ts'

const run = promisify(execFile)

export interface FleetWorkersOptions {
  claudeDir: string // ~/.claude
  forgetBin: string // ~/bin/agent-session-forget
  machine: string // "Homelab"
}

const read = (p: string) => fs.readFile(p, 'utf8').catch(() => '')

export class FleetWorkers implements WorkerSource {
  private o: FleetWorkersOptions
  constructor(o: FleetWorkersOptions) {
    this.o = o
  }

  private async registered(): Promise<Registered[]> {
    return parseRegistry(await read(join(this.o.claudeDir, 'agent-sessions.tsv')))
  }

  private async screen(slug: string): Promise<string | null> {
    try {
      return (await run('tmux', ['-L', 'agents', 'capture-pane', '-pt', slug, '-J'], { timeout: 3000 })).stdout
    } catch {
      return null
    }
  }

  /** The last 128 KB of the worker's transcript (enough for its latest steps). */
  private async transcriptTail(r: Registered): Promise<string> {
    const fh = await fs.open(transcriptPath(this.o.claudeDir, r.dir, r.uuid), 'r').catch(() => null)
    if (!fh) return ''
    try {
      const { size } = await fh.stat()
      const len = Math.min(size, 128 * 1024)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, size - len)
      return buf.toString('utf8')
    } finally {
      await fh.close()
    }
  }

  /** When the worker's transcript was last written (ISO), or null. */
  private async transcriptAt(r: Registered): Promise<string | null> {
    const st = await fs.stat(transcriptPath(this.o.claudeDir, r.dir, r.uuid)).catch(() => null)
    return st ? st.mtime.toISOString() : null
  }

  private async summary(r: Registered, backlog: string): Promise<WorkerSummary & { active: boolean; lines: ReturnType<typeof parseStatus> }> {
    const lines = parseStatus(await read(join(this.o.claudeDir, 'fleet', 'status', `${r.slug}.status`)))
    const last = lines.at(-1)
    const pane = paneStateFrom(await this.screen(r.slug))
    const state = workerState(pane, last)
    // Only a working worker has a "now": otherwise the row stays quiet.
    const activity = state === 'working' ? latestActivity(await this.transcriptTail(r))?.label ?? 'Working' : null
    return {
      id: r.slug,
      title: r.title,
      state,
      now: last?.text ?? 'Starting',
      at: last?.at ?? null,
      job: jobFor(backlog, r.title),
      activity,
      activeAt: latestOf(await this.transcriptAt(r), last?.at),
      active: isActive(pane),
      lines,
    }
  }

  /** Active workers only: registered and with a live tmux session. */
  async list(): Promise<WorkerSummary[]> {
    const backlog = await read(join(this.o.claudeDir, 'fleet', 'backlog.tsv'))
    const all = await Promise.all((await this.registered()).map((r) => this.summary(r, backlog)))
    return sortWorkers(all.filter((s) => s.active).map(({ lines: _lines, active: _active, ...s }) => s))
  }

  async get(id: string): Promise<WorkerDetail | null> {
    const r = (await this.registered()).find((x) => x.slug === id)
    if (!r) return null
    const { lines, active: _active, ...s } = await this.summary(r, await read(join(this.o.claudeDir, 'fleet', 'backlog.tsv')))
    const started = await run('tmux', ['-L', 'agents', 'display', '-p', '-t', r.slug, '#{session_created}'], { timeout: 3000 })
      .then((x) => new Date(Number(x.stdout.trim()) * 1000).toISOString())
      .catch(() => lines[0]?.at ?? null)
    const agentFile = await read(join(this.o.claudeDir, 'agents', `${r.agent}.md`))
    const modelId = /^model:\s*(\S+)/m.exec(agentFile)?.[1] ?? ''
    return {
      ...s,
      lines: lines.slice(-6),
      startedAt: started,
      machine: this.o.machine,
      model: claudeLabel(modelId) ?? (modelId || 'Claude'),
      agent: r.agent,
      dir: r.dir,
    }
  }

  async stop(id: string): Promise<void> {
    const r = (await this.registered()).find((x) => x.slug === id)
    if (!r) throw new Error('No such worker')
    await run(this.o.forgetBin, [r.remoteId], { timeout: 15000 })
  }
}
