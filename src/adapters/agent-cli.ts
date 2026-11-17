// Whether an agent is installed and signed in, from its own CLI: `--version`, then `claude auth status`
// or `codex login status`. The sign-in stays where the agent keeps it (Claude: its credentials or the
// Keychain; Codex: ~/.codex); this only asks. An API key Limeade holds (or one in the hub's environment)
// counts as signed in. Remembered for half a minute: the model list asks on every open.

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { API_KEY_ENV, claudeSignIn, codexSignIn, parseVersion, type SignInState } from '../domain/agent-setup.ts'
import type { Agent, AgentStatus } from '../domain/models.ts'
import type { AgentSetup } from '../ports.ts'

/** Where an agent's command is: Limeade's own install first (so its updates win), then PATH. */
export function findAgentBin(bin: string, prefix: string, pathVar = process.env.PATH ?? ''): string | null {
  if (bin.includes('/')) return isFile(bin) ? bin : null
  for (const d of [join(prefix, 'bin'), ...pathVar.split(delimiter).filter(Boolean)]) {
    const p = join(d, bin)
    if (isFile(p)) return p
  }
  return null
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export class AgentCli implements AgentSetup {
  private o: {
    agent: Agent
    /** The command's path now, or null when it isn't installed. */
    find: () => string | null
    /** Limeade's install folder: a command under it is Limeade's to update. */
    prefix: string
    env?: () => NodeJS.ProcessEnv
    ttlMs?: number
  }
  private last: { at: number; status: Promise<AgentStatus> } | null = null
  constructor(o: AgentCli['o']) {
    this.o = o
  }

  status(): Promise<AgentStatus> {
    const now = Date.now()
    if (this.last && now - this.last.at < (this.o.ttlMs ?? 30_000)) return this.last.status
    const status = this.check()
    this.last = { at: now, status }
    return status
  }

  forget(): void {
    this.last = null
  }

  private async check(): Promise<AgentStatus> {
    const path = this.o.find()
    if (!path || !existsSync(path)) return { installed: false, signedIn: false, version: null, path: null, managed: false, how: null, account: null }
    const env = { ...(this.o.env?.() ?? process.env), NO_COLOR: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' }
    const [version, signIn] = await Promise.all([run(path, ['--version'], env).then((r) => parseVersion(r.out)), this.signIn(path, env)])
    return { installed: true, signedIn: signIn.signedIn, version, path, managed: path.startsWith(join(this.o.prefix, 'bin') + '/'), how: signIn.how, account: signIn.account }
  }

  private async signIn(path: string, env: NodeJS.ProcessEnv): Promise<SignInState> {
    if (this.o.agent === 'claude') return claudeSignIn((await run(path, ['auth', 'status', '--json'], env)).stdout)
    if (env[API_KEY_ENV.codex] || env.OPENAI_API_KEY) return { signedIn: true, how: 'api-key', account: null }
    const r = await run(path, ['login', 'status'], env)
    return codexSignIn(r.out, r.ok)
  }
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; stdout: string; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 10_000, cwd: env.HOME }, (err, stdout, stderr) => resolve({ ok: !err, stdout, out: `${stdout}\n${stderr}` }))
  })
}
