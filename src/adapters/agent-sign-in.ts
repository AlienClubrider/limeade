// An agent's own sign-in, run through its CLI so the sign-in lands where the agent keeps it:
// - Claude: `claude auth login --claudeai|--console` prints a link; the page it opens shows a code, which
//   comes back here and goes to the CLI's "Paste code here" prompt.
// - Codex: `codex login --device-auth` prints a link and a one-time code to type on that page; the CLI
//   waits until that's done.
// - Claude's long-lived token: `claude setup-token`, the same link and code, but it's a terminal app, so it
//   runs under `script` (a pseudo-terminal). It prints the token once at the end; `keep` takes it from the
//   output (which stays in memory) before the run counts as done.
// Limeade shows the link (and code). It never sees the agents' own sign-ins; the token is the one exception,
// and only `keep` handles it.

import { spawn, type ChildProcess } from 'node:child_process'
import { signInFailure, signInLink } from '../domain/agent-setup.ts'
import type { Agent } from '../domain/models.ts'
import type { AgentSignIn, SignInRun } from '../ports.ts'

const START_MS = 20_000
const CHECK_MS = 30_000
/** Codex's device code lasts 15 minutes; Claude's is no better. */
const LIFETIME_MS = 15 * 60_000

export type SignInWay = 'subscription' | 'console' | 'chatgpt' | 'token'

export function signInArgs(agent: Agent, how: Exclude<SignInWay, 'token'>): string[] {
  if (agent === 'codex') return ['login', '--device-auth']
  return ['auth', 'login', how === 'console' ? '--console' : '--claudeai']
}

/** A word for sh, quoted. */
const shWord = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The command to run: the CLI itself, or for `setup-token` the CLI inside a wide pseudo-terminal (so the
 * token isn't wrapped across lines). util-linux `script` on Linux, BSD `script` on macOS.
 */
export function signInCommand(agent: Agent, how: SignInWay, bin: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (how !== 'token') return { cmd: bin, args: signInArgs(agent, how) }
  const inner = `stty cols 1000 rows 50 2>/dev/null; exec ${shWord(bin)} setup-token`
  return platform === 'darwin'
    ? { cmd: 'script', args: ['-q', '/dev/null', 'sh', '-c', inner] }
    : { cmd: 'script', args: ['-qfec', inner, '/dev/null'] }
}

interface Live {
  run: SignInRun
  child: ChildProcess
  out: string
  /** Wakes whoever waits for the next change (the link, or the end). */
  changed: Set<() => void>
  /** A terminal app takes Enter as a carriage return. */
  enter: string
}

export class CliSignIn implements AgentSignIn {
  private o: {
    env?: () => NodeJS.ProcessEnv
    startMs?: number
    checkMs?: number
    /** After a sign-in ends well, before it counts as done: keeps what it made (the token). Throws to fail it. */
    keep?: (agent: Agent, how: SignInWay, output: string) => Promise<void>
  }
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

  async start(agent: Agent, how: SignInWay, bin: string, done: () => void): Promise<SignInRun> {
    this.cancel(agent)
    const { cmd, args } = signInCommand(agent, how, bin)
    const { CLAUDE_CODE_OAUTH_TOKEN: _, ...env } = this.o.env?.() ?? process.env
    const child = spawn(cmd, args, {
      env: { ...env, NO_COLOR: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const l: Live = { run: { state: 'starting', link: null, error: null, how }, child, out: '', changed: new Set(), enter: how === 'token' ? '\r' : '\n' }
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
    child.on('exit', async (code) => {
      clearTimeout(lifetime)
      if (l.run.state !== 'failed') {
        if (code === 0) {
          try {
            await this.o.keep?.(agent, how, l.out)
            l.run = { ...l.run, state: 'done', error: null }
          } catch (err) {
            l.run = { ...l.run, state: 'failed', error: (err as Error).message }
          }
        } else l.run = { ...l.run, state: 'failed', error: signInFailure(l.out) ?? 'The sign-in stopped. Start again.' }
      }
      // What it printed (a token, maybe) isn't kept past the end.
      l.out = ''
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
    l.child.stdin!.write(`${code}${l.enter}`)
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
