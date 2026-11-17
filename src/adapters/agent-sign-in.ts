// An agent's own sign-in, run through its CLI so the sign-in lands where the agent keeps it:
// - Claude: `claude auth login --claudeai|--console` prints a link; the page it opens shows a code, which
//   comes back here and goes to the CLI's "Paste code here" prompt.
// - Codex: `codex login --device-auth` prints a link and a one-time code to type on that page; the CLI
//   waits until that's done.
// Limeade shows the link (and code); it never sees the agent's tokens.

import { spawn, type ChildProcess } from 'node:child_process'
import { signInFailure, signInLink } from '../domain/agent-setup.ts'
import type { Agent } from '../domain/models.ts'
import type { AgentSignIn, SignInRun } from '../ports.ts'

const START_MS = 20_000
const CHECK_MS = 30_000
/** Codex's device code lasts 15 minutes; Claude's is no better. */
const LIFETIME_MS = 15 * 60_000

export function signInArgs(agent: Agent, how: 'subscription' | 'console' | 'chatgpt'): string[] {
  if (agent === 'codex') return ['login', '--device-auth']
  return ['auth', 'login', how === 'console' ? '--console' : '--claudeai']
}

interface Live {
  run: SignInRun
  child: ChildProcess
  out: string
  /** Wakes whoever waits for the next change (the link, or the end). */
  changed: Set<() => void>
}

export class CliSignIn implements AgentSignIn {
  private o: { env?: () => NodeJS.ProcessEnv; startMs?: number; checkMs?: number }
  private live = new Map<Agent, Live>()
  constructor(o: CliSignIn['o'] = {}) {
    this.o = o
  }

  run(agent: Agent): SignInRun | null {
    return this.live.get(agent)?.run ?? null
  }

  cancel(agent: Agent): void {
    const l = this.live.get(agent)
    if (!l) return
    this.live.delete(agent)
    if (l.run.state === 'starting' || l.run.state === 'waiting' || l.run.state === 'checking') l.child.kill()
  }

  async start(agent: Agent, how: 'subscription' | 'console' | 'chatgpt', bin: string, done: () => void): Promise<SignInRun> {
    this.cancel(agent)
    const child = spawn(bin, signInArgs(agent, how), {
      env: { ...(this.o.env?.() ?? process.env), NO_COLOR: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const l: Live = { run: { state: 'starting', link: null, error: null }, child, out: '', changed: new Set() }
    this.live.set(agent, l)
    const wake = () => {
      const waiting = [...l.changed]
      l.changed.clear()
      for (const f of waiting) f()
    }
    const take = (chunk: Buffer) => {
      l.out = (l.out + chunk.toString()).slice(-20_000)
      if (!l.run.link) {
        const link = signInLink(agent, l.out)
        if (link) {
          l.run = { ...l.run, state: 'waiting', link }
          wake()
        }
      }
    }
    child.stdout!.on('data', take)
    child.stderr!.on('data', take)
    child.stdin!.on('error', () => {})
    const lifetime = setTimeout(() => {
      if (this.live.get(agent) === l) {
        l.run = { ...l.run, state: 'failed', error: 'The sign-in timed out. Start again.' }
        child.kill()
      }
    }, LIFETIME_MS)
    lifetime.unref()
    child.on('error', (err) => {
      l.run = { ...l.run, state: 'failed', error: `Couldn't start the sign-in: ${err.message}` }
      wake()
    })
    child.on('exit', (code) => {
      clearTimeout(lifetime)
      if (l.run.state !== 'failed') {
        l.run = code === 0 ? { ...l.run, state: 'done', error: null } : { ...l.run, state: 'failed', error: signInFailure(l.out) ?? 'The sign-in stopped. Start again.' }
      }
      wake()
      if (this.live.get(agent) === l) done()
    })
    await this.until(l, () => l.run.state !== 'starting', this.o.startMs ?? START_MS)
    if (l.run.state === 'starting') {
      l.run = { ...l.run, state: 'failed', error: "The sign-in link didn't come. Start again." }
      child.kill()
    }
    return l.run
  }

  async sendCode(agent: Agent, code: string): Promise<SignInRun> {
    const l = this.live.get(agent)
    if (!l || l.run.state !== 'waiting' || !l.run.link?.wantsCode) throw new Error('Start the sign-in first')
    l.run = { ...l.run, state: 'checking', error: null }
    l.child.stdin!.write(`${code}\n`)
    await this.until(l, () => l.run.state !== 'checking', this.o.checkMs ?? CHECK_MS)
    return l.run
  }

  private until(l: Live, ok: () => boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ok()) return resolve()
      const t = setTimeout(finish, ms)
      function finish() {
        clearTimeout(t)
        l.changed.delete(check)
        resolve()
      }
      function check() {
        if (ok()) finish()
        else l.changed.add(check)
      }
      l.changed.add(check)
    })
  }
}
