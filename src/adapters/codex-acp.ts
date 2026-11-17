// Runs one Codex turn through ACP with the Codex ACP adapter (@agentclientprotocol/codex-acp), which drives
// the installed Codex CLI with its own sign-in. The turn itself runs in acp-turns.ts, exactly as Claude's
// does; this file is what's Codex's own: its modes, its config (model, effort, a local model's machine) and
// how its tool calls read.

import { existsSync } from 'node:fs'
import type { Mode } from '../domain/chat.ts'
import type { TurnRequest } from '../ports.ts'
import type { AcpTurnSpec } from './acp-keeper.ts'
import { AcpTurns, packageEntry, type AcpAgent, type AcpTool, type AcpTurnsOptions } from './acp-turns.ts'

/** Codex turns' handles (and folders) start with this. */
export const CODEX_HANDLE_PREFIX = 'codex-'
/** The provider id local models run under (an Ollama machine's OpenAI-compatible /v1). */
export const LOCAL_PROVIDER = 'limeade-ollama'

/** An Ollama model on one of the machines, for a local model's name in the picker. */
export interface OllamaModel {
  /** The machine's Ollama, e.g. http://192.0.2.10:11434 */
  url: string
  /** Ollama's tag, e.g. gemma4:26b */
  tag: string
  /** The machine, e.g. MacBook Pro */
  machine: string
}

export interface CodexAcpOptions extends AcpTurnsOptions {
  /** The Codex CLI the adapter drives (an absolute path). */
  codexBin: string
  /** Local models: which Ollama model a picker name is (null when no machine has it now). */
  local?: (name: string) => Promise<OllamaModel | null>
  /** A persona's instructions (the Assistant's), for a turn that runs as one; null when there's none. */
  persona?: (id: string) => Promise<string | null>
}

/** The adapter's own entry point, from the installed package. */
export function codexAdapterEntry(): string {
  return packageEntry('@agentclientprotocol/codex-acp')
}

/**
 * The app's mode chip as Codex's mode (its approval and sandbox preset). "Ask" is Codex's read-only:
 * nothing changes without a yes. Plan is read-only too, with Codex's own plan collaboration mode on.
 */
export function codexMode(mode: Mode): { modeId: string; config: NonNullable<AcpTurnSpec['config']> } {
  const modeId = mode === 'acceptEdits' ? 'workspace-write' : mode === 'auto' ? 'agent' : 'read-only'
  return { modeId, config: [{ configId: 'collaboration_mode', value: mode === 'plan' ? 'plan' : 'default' }] }
}

/** Codex's config for one turn (the adapter's CODEX_CONFIG): the model and effort, or a local model's machine. */
export function codexConfig(req: Pick<TurnRequest, 'model' | 'effort'>, local: OllamaModel | null): Record<string, unknown> {
  if (!local) return { model: req.model, model_reasoning_effort: req.effort }
  return {
    model: local.tag,
    model_provider: LOCAL_PROVIDER,
    model_providers: { [LOCAL_PROVIDER]: { name: `Ollama on ${local.machine}`, base_url: `${local.url.replace(/\/$/, '')}/v1`, wire_api: 'responses' } },
  }
}

/**
 * The session/new (and session/resume) params: the folder, the uploads folder and, for a turn that runs as
 * a persona (the Assistant), its instructions and the hub's note. Codex has no "start as this agent" (its
 * custom agents are only for helpers it spawns), so these go in as text the adapter adds to Codex's
 * developer instructions.
 */
export function codexSession(
  req: Pick<TurnRequest, 'cwd' | 'appendSystemPrompt'>, o: { cwd: string; addDirs?: readonly string[] }, persona?: string | null,
): AcpTurnSpec['session'] {
  const text = [persona?.trim(), req.appendSystemPrompt?.trim()].filter(Boolean).join('\n\n')
  return {
    cwd: req.cwd ?? o.cwd,
    mcpServers: [],
    ...(o.addDirs?.length ? { additionalDirectories: [...o.addDirs] } : {}),
    ...(text ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text }] } } : {}),
  }
}

/**
 * A Codex tool call as the app's tool. Codex says what kind of call it is (execute, read, search, edit,
 * fetch, think) rather than naming a tool, so each kind takes the Claude Code tool name that reads the same.
 */
export function codexTool(call: any): AcpTool | null {
  const raw = call?.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}
  const title = typeof call?.title === 'string' ? call.title : ''
  const where = pathOf(call?.locations?.[0]) ?? (Array.isArray(call?.content) ? pathOf(call.content.find((c: any) => c?.type === 'diff')) : undefined)
  switch (call?.kind) {
    case 'think':
      return null
    case 'execute':
      return { name: 'Bash', input: { command: unwrapShell(typeof raw.command === 'string' ? raw.command : title) } }
    case 'read':
      return where ? { name: 'Read', input: { file_path: where } } : { name: 'Glob', input: { pattern: title.replace(/^List files( in )?/, '').replace(/^'|'$/g, '') || '.' } }
    case 'search':
      return { name: 'Grep', input: { pattern: typeof raw.query === 'string' ? raw.query : title } }
    case 'edit':
    case 'delete':
    case 'move':
      return { name: 'Edit', input: where ? { file_path: where } : {} }
    case 'fetch':
      return typeof raw.url === 'string' ? { name: 'WebFetch', input: { url: raw.url } } : { name: 'WebSearch', input: { query: typeof raw.query === 'string' ? raw.query : title } }
    default:
      return { name: title || String(call?.name ?? 'Tool'), input: raw }
  }
}

/** An escalated command comes wrapped ("/bin/bash -lc 'echo hi'"): the command is what's inside. */
function unwrapShell(command: string): string {
  const m = /^(?:\/usr)?\/bin\/(?:ba|z)?sh -l?c '(.*)'$/s.exec(command)
  return m ? m[1]!.replace(/'\\''/g, "'") : command
}

function pathOf(x: any): string | undefined {
  return typeof x === 'string' ? x : typeof x?.path === 'string' ? x.path : undefined
}

/** Codex's notes to the person at the keyboard ("Warning: Model metadata for … not found") come as text without a message. */
function codexNoise(update: any): boolean {
  return typeof update?.messageId !== 'string' && /^Warning: /.test(String(update?.content?.text ?? ''))
}

/** An error's own words, safe to show: anything that looks like a key or token is hidden, and it's kept short. */
export function codexCause(error: string): string {
  const text = error
    .replace(/\bbearer\s+\S+/gi, 'Bearer …')
    .replace(/[A-Za-z0-9_\-.+/=]{24,}/g, (w) => (/[0-9]/.test(w) && /[A-Za-z]/.test(w) && !w.startsWith('/') ? '…' : w))
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 300 ? `${text.slice(0, 299)}…` : text
}

/**
 * A sign-in failure, with what Codex said. With an API key in play (Codex's own, or a custom provider's), the
 * key was there but refused, so signing in again isn't the fix: the key Limeade starts Codex with is.
 */
export function codexFailure(e: { error?: string; stage?: string }, env: NodeJS.ProcessEnv = {}): string | undefined {
  if (!/authenticat|not logged in|sign in|unauthori[sz]ed|\b401\b/i.test(e.error ?? '')) return undefined
  const cause = codexCause(e.error ?? '')
  if (env.CODEX_API_KEY || env.OPENAI_API_KEY) {
    return `Codex's provider refused its API key (${cause}). Check the key in Settings › Agents or limeade.env (it wins over the service's environment), then restart Limeade`
  }
  return `Codex isn't signed in on this box (${cause}): sign in under Settings › Agents, or pick a local model`
}

function codexAgent(o: CodexAcpOptions): AcpAgent {
  return {
    name: 'Codex',
    handlePrefix: CODEX_HANDLE_PREFIX,
    turn: async (req) => {
      if (!existsSync(o.codexBin)) throw new Error("Codex isn't installed on this box")
      const local = o.local ? await o.local(req.model) : null
      if (o.local && !local) throw new Error(`${req.model} isn't on any of your machines now`)
      const persona = req.agent ? ((await o.persona?.(req.agent)) ?? null) : null
      if (req.agent && !persona) throw new Error(`Codex has no ${req.agent} agent on this box: add it on the Agents page`)
      const { modeId, config } = codexMode(req.mode)
      const env = { ...process.env, ...o.env }
      return {
        env: {
          CODEX_PATH: o.codexBin,
          CODEX_CONFIG: JSON.stringify(codexConfig(req, local)),
          // No browser sign-in from a server, and no predicted next prompts (the app doesn't show them).
          NO_BROWSER: '1',
          CODEX_ACP_PROMPT_SUGGESTIONS: 'false',
          // An API key (the hub's environment, or one saved in Settings › Agents) signs Codex in when it has no sign-in of its own.
          ...(!local && (env.CODEX_API_KEY || env.OPENAI_API_KEY) ? { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key' }) } : {}),
        },
        spec: { session: codexSession(req, o, persona), modeId, config },
        inlinePhotos: true,
      }
    },
    tool: codexTool,
    noise: codexNoise,
    failure: (e) => codexFailure(e, { ...process.env, ...o.env }),
  }
}

export class CodexAcp extends AcpTurns {
  constructor(o: CodexAcpOptions) {
    super(o, codexAgent(o))
  }
}
