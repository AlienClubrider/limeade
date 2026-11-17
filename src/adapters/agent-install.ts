// One tap installs an agent: `npm install -g --prefix <folder> <package>@<pinned version>`, into a folder
// the user owns (no sudo), with npm's update notices, funding notes and audit calls off. Updating is the
// same command with a newer pin.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGENT_PACKAGES } from '../domain/agent-setup.ts'
import type { Agent } from '../domain/models.ts'
import type { AgentInstaller, InstallRun } from '../ports.ts'

const LOG_TAIL = 2000

/** npm next to the node running the hub (a Homebrew or nvm node has its own), else the one on PATH. */
export function npmBin(): string {
  const beside = join(dirname(process.execPath), 'npm')
  return existsSync(beside) ? beside : 'npm'
}

export function installArgs(agent: Agent, prefix: string): string[] {
  const p = AGENT_PACKAGES[agent]
  return ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error', `${p.pkg}@${p.version}`]
}

export class NpmInstall implements AgentInstaller {
  private o: { prefix: string; npm?: string; env?: NodeJS.ProcessEnv }
  private runs = new Map<Agent, InstallRun>()
  constructor(o: NpmInstall['o']) {
    this.o = o
  }

  run(agent: Agent): InstallRun | null {
    return this.runs.get(agent) ?? null
  }

  start(agent: Agent, done: () => void): InstallRun {
    const running = this.runs.get(agent)
    if (running?.running) return running
    const r: InstallRun = { version: AGENT_PACKAGES[agent].version, running: true, error: null, log: '' }
    this.runs.set(agent, r)
    const keep = (chunk: Buffer) => {
      r.log = (r.log + chunk.toString()).slice(-LOG_TAIL)
    }
    const end = (error: string | null) => {
      if (!r.running) return
      r.running = false
      r.error = error
      done()
    }
    const child = spawn(this.o.npm ?? npmBin(), installArgs(agent, this.o.prefix), {
      env: {
        ...(this.o.env ?? process.env),
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        DISABLE_TELEMETRY: '1',
        DO_NOT_TRACK: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (err) => end(`Couldn't run npm: ${err.message}`))
    child.on('exit', (code) => end(code === 0 ? null : lastLine(r.log) || `npm stopped (exit ${code})`))
    return r
  }
}

function lastLine(log: string): string {
  return log.trim().split('\n').filter((l) => /\S/.test(l)).slice(-3).join(' ').slice(0, 300)
}

/** Codex's settings with no usage analytics, feedback uploads, OpenTelemetry export or update checks. */
export const CODEX_QUIET_CONFIG = `# Written by Limeade when it installed Codex: no usage analytics, feedback uploads,
# OpenTelemetry export or update checks. Yours to change.
check_for_update_on_startup = false

[analytics]
enabled = false

[feedback]
enabled = false

[otel]
exporter = "none"
log_user_prompt = false
`

/** After Limeade installs Codex: telemetry off, unless Codex already has settings (those stay as they are). */
export function quietCodex(codexHome: string): boolean {
  const file = join(codexHome, 'config.toml')
  if (existsSync(file)) return false
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  writeFileSync(file, CODEX_QUIET_CONFIG, { mode: 0o600, flag: 'wx' })
  return true
}
