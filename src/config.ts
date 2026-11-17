// Everything the hub is wired with, read from the environment once. The defaults are for a fresh
// computer (Limeade installed with one command); a server with its own setup (other folders, Cloudflare
// Access, LiteLLM, its own worker scripts) says so in its service's environment. Pure: no I/O.

import { join } from 'node:path'
import { parseEnv } from 'node:util'

export interface HubConfig {
  port: number
  stateDir: string
  configDir: string
  uploadsDir: string
  /** Where the Assistant and new chats work. */
  workDir: string
  /** Chats may pick folders under here. */
  chatHome: string
  /** Shown for this computer (Settings, the chat's "where"). */
  machineName: string
  agentsPrefix: string
  claudeBin: string
  codexBin: string
  codexHome: string | null
  turnTimeoutMs: number
  /** Empty: the first local model, else Claude. */
  defaultChatModel: string
  /** Browser sign-in through Cloudflare Access; null means the browser on this computer is the owner. */
  access: { team: string; aud: string; emails: string[] } | null
  /** Other names this computer's page is reached by (a Tailscale name), for the browser sign-in. */
  trustedHosts: string[]
  devLogin: boolean
  pushSubject: string
  webDir: string | null
  /** LiteLLM in front of the Ollama machines (a server setup), or straight to one Ollama (the default). */
  localModels:
    | { kind: 'litellm'; url: string; machinesFile: string; modelsFile: string; sync: boolean }
    | { kind: 'ollama'; url: string }
  /**
   * Workers: built in (the hub runs them as chats; `fleet` is bundled), or a server's own scripts
   * (tmux sessions and a fleet folder they keep).
   */
  fleet:
    | { kind: 'builtin'; dir: string }
    | { kind: 'scripts'; dir: string; claudeDir: string; binDir: string; forgetBin: string; handoff: string | null }
  fleetPollMs: number
  toolboxUrl: string
}

type Env = Readonly<Record<string, string | undefined>>

const DEFAULT_OLLAMA = 'http://localhost:11434'
/** A real-looking contact: Apple's push service refuses VAPID subjects on localhost. */
const DEFAULT_PUSH_SUBJECT = 'mailto:limeade@users.noreply.github.com'

/** "~/x" -> "<home>/x"; anything else as it is. */
export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export function hubConfig(env: Env, home: string, appDir: string): HubConfig {
  const path = (v: string | undefined, fallback: string) => expandHome(v?.trim() || fallback, home)
  const stateDir = path(env.STATE_DIR, join(home, '.local/state/limeade'))
  const configDir = path(env.CONFIG_DIR, join(home, '.config/limeade'))
  const agentsPrefix = path(env.AGENTS_PREFIX, join(home, '.local'))
  const workDir = path(env.WORK_DIR, home)
  const team = env.CF_ACCESS_TEAM?.trim() ?? ''
  const aud = env.CF_ACCESS_AUD?.trim() ?? ''
  const claudeDir = join(home, '.claude')
  const binDir = path(env.FLEET_BIN, join(home, 'bin'))
  return {
    port: Number(env.PORT || 8797),
    stateDir,
    configDir,
    uploadsDir: path(env.UPLOADS_DIR, join(stateDir, 'uploads')),
    workDir,
    chatHome: path(env.CHAT_HOME, home),
    machineName: env.MACHINE_NAME?.trim() || 'This computer',
    agentsPrefix,
    claudeBin: env.CLAUDE_BIN || 'claude',
    codexBin: env.CODEX_BIN || 'codex',
    codexHome: env.CODEX_HOME ? expandHome(env.CODEX_HOME, home) : null,
    turnTimeoutMs: Number(env.TURN_TIMEOUT_MS || 30 * 60_000),
    defaultChatModel: env.DEFAULT_CHAT_MODEL?.trim() ?? '',
    access: team && aud ? { team, aud, emails: list(env.ALLOWED_EMAILS) } : null,
    trustedHosts: list(env.TRUSTED_HOSTS).map((h) => h.toLowerCase()),
    devLogin: env.DEV_LOGIN === '1',
    pushSubject: env.PUSH_SUBJECT?.trim() || DEFAULT_PUSH_SUBJECT,
    webDir: path(env.WEB_DIR, join(appDir, 'public')),
    localModels: env.LITELLM_URL
      ? {
          kind: 'litellm',
          url: env.LITELLM_URL,
          machinesFile: path(env.LOCAL_MODELS_CONFIG, join(configDir, 'local-models.json')),
          modelsFile: path(env.LITELLM_MODELS_FILE, join(stateDir, 'local-models.yaml')),
          sync: env.LOCAL_MODELS_SYNC === '1',
        }
      : { kind: 'ollama', url: env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA },
    fleet: env.FLEET === 'scripts'
      ? {
          kind: 'scripts',
          dir: path(env.FLEET_HOME, join(claudeDir, 'fleet')),
          claudeDir,
          binDir,
          forgetBin: path(env.FORGET_BIN, join(binDir, 'agent-session-forget')),
          handoff: env.HANDOFF_FILE ? expandHome(env.HANDOFF_FILE, home) : null,
        }
      : { kind: 'builtin', dir: path(env.FLEET_HOME, join(stateDir, 'fleet')) },
    fleetPollMs: Number(env.FLEET_POLL_MS || 10_000),
    toolboxUrl: env.TOOLBOX_URL || 'http://127.0.0.1:8787',
  }
}

/** The settings files Node was started with (--env-file / --env-file-if-exists), in the order given. */
export function envFilesOf(execArgv: readonly string[]): string[] {
  const files: string[] = []
  for (let i = 0; i < execArgv.length; i++) {
    const m = /^--env-file(?:-if-exists)?(?:=(.*))?$/.exec(execArgv[i]!)
    if (!m) continue
    const path = m[1] ?? execArgv[++i]
    if (path) files.push(path)
  }
  return files
}

/**
 * Makes Limeade's own settings file win over what the process inherited. Node's --env-file keeps a
 * variable that is already set, so a stale key in launchd's, systemd's or the shell's environment would
 * shadow the one in limeade.env; this puts the file's values back. Only the names the file sets change.
 * `read` returns a file's text, or null when it isn't there.
 */
export function applyEnvFiles(env: Record<string, string | undefined>, execArgv: readonly string[], read: (path: string) => string | null): void {
  for (const path of envFilesOf(execArgv)) {
    const text = read(path)
    if (text !== null) Object.assign(env, parseEnv(text))
  }
}
