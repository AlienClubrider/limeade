// Monitors on disk: <dir>/<id>/monitor.json (the monitor with its last runs) and <dir>/<id>/logs/<run>.log.
// Private to the user the hub runs as. Also the check runner: a monitor's shell command, with a time limit.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Monitor } from '../domain/monitors.ts'
import type { CheckRunner, MonitorStore } from '../ports.ts'

const SAFE_ID = /^[a-z0-9-]{1,64}$/i

export class MonitorFiles implements MonitorStore {
  private dir: string
  private writes = new Map<string, Promise<unknown>>()
  constructor(dir: string) {
    this.dir = dir
  }

  private path(id: string, ...rest: string[]): string {
    if (!SAFE_ID.test(id) || rest.some((r) => !/^[\w.-]+$/.test(r))) throw new Error('Bad monitor id')
    return join(this.dir, id, ...rest)
  }

  async list(): Promise<Monitor[]> {
    let ids: string[] = []
    try {
      ids = await fs.readdir(this.dir)
    } catch {
      return []
    }
    const out: Monitor[] = []
    for (const id of ids.filter((i) => SAFE_ID.test(i))) {
      try {
        out.push(JSON.parse(await fs.readFile(this.path(id, 'monitor.json'), 'utf8')))
      } catch {}
    }
    return out
  }

  /** One write at a time per monitor, newest wins. */
  save(m: Monitor): Promise<void> {
    const data = JSON.stringify(m, null, 1)
    const file = this.path(m.id, 'monitor.json')
    const run = (this.writes.get(m.id) ?? Promise.resolve()).then(() => writeAtomic(file, data))
    this.writes.set(m.id, run.catch(() => undefined))
    return run
  }

  async remove(id: string): Promise<void> {
    await (this.writes.get(id) ?? Promise.resolve())
    this.writes.delete(id)
    await fs.rm(this.path(id), { recursive: true, force: true })
  }

  async writeLog(id: string, runId: string, text: string): Promise<void> {
    await writeAtomic(this.path(id, 'logs', `${runId}.log`), text)
  }

  async readLog(id: string, runId: string): Promise<string | null> {
    try {
      return await fs.readFile(this.path(id, 'logs', `${runId}.log`), 'utf8')
    } catch {
      return null
    }
  }

  async removeLog(id: string, runId: string): Promise<void> {
    await fs.rm(this.path(id, 'logs', `${runId}.log`), { force: true })
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tmp, data, { mode: 0o600 })
  await fs.rename(tmp, path)
}

/** Runs a check with /bin/sh in the monitor's folder: its output (stdout, at most 64 KB), killed after the time limit. */
export class ShellCheck implements CheckRunner {
  private o: { timeoutMs?: number; env?: () => NodeJS.ProcessEnv }
  constructor(o: ShellCheck['o'] = {}) {
    this.o = o
  }

  run(command: string, cwd: string): Promise<{ output: string; code: number | null; error?: string }> {
    const timeoutMs = this.o.timeoutMs ?? 60_000
    return new Promise((done) => {
      let out = ''
      let timedOut = false
      const child = spawn('/bin/sh', ['-c', command], { cwd, env: this.o.env?.() ?? process.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
      const timer = setTimeout(() => {
        timedOut = true
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {}
      }, timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (s: string) => {
        if (out.length < 65_536) out += s
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        done({ output: '', code: null, error: err.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (timedOut) done({ output: '', code: null, error: `took longer than ${Math.round(timeoutMs / 1000)} s` })
        else done({ output: out.slice(0, 65_536).trim(), code })
      })
    })
  }
}
