// Does a Claude credential still work? `claude auth status` only reads a local file, so this asks the model
// for one word, on the cheapest model, with no tools, MCP servers, settings or saved session. The login
// probe runs without CLAUDE_CODE_OAUTH_TOKEN; the token probe runs with it.

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAuthFailure, type ProbeOutcome } from '../domain/claude-health.ts'

const TIMEOUT_MS = 90_000

export const PROBE_ARGS = [
  '-p', 'Reply with the single word: ok',
  '--model', 'haiku',
  '--tools', '',
  '--strict-mcp-config',
  '--setting-sources', '',
  '--no-session-persistence',
]

export class ClaudeProbe {
  private o: { bin: () => string; env: () => NodeJS.ProcessEnv; timeoutMs?: number }
  constructor(o: ClaudeProbe['o']) {
    this.o = o
  }

  /** ok, auth (refused: needs a sign-in), or other (couldn't tell: offline, CLI missing, a model error). */
  run(token: string | null): Promise<{ outcome: ProbeOutcome; detail: string }> {
    const { CLAUDE_CODE_OAUTH_TOKEN: _, ...env } = this.o.env()
    return new Promise((resolve) => {
      let out = ''
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(this.o.bin(), PROBE_ARGS, {
          cwd: tmpdir(),
          env: { ...env, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}), DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        return resolve({ outcome: 'other', detail: (err as Error).message })
      }
      const take = (b: Buffer) => {
        out = (out + b.toString()).slice(-4000)
      }
      child.stdout!.on('data', take)
      child.stderr!.on('data', take)
      const timer = setTimeout(() => child.kill(), this.o.timeoutMs ?? TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ outcome: 'other', detail: err.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        // The token never comes back in what the CLI prints, but be sure it isn't passed on.
        const detail = (token ? out.split(token).join('…') : out).trim().slice(-300)
        if (code === 0) resolve({ outcome: 'ok', detail: '' })
        else resolve({ outcome: isAuthFailure(out) ? 'auth' : 'other', detail })
      })
    })
  }
}
