// The model list the app shows: Claude models on the user's subscription, Codex's on its OpenAI sign-in,
// then local models by machine. A chat runs on an agent (Claude Code or Codex); local models work in either.

export type Engine = 'claude' | 'local' | 'codex'

/** The agent a chat runs on. Chats made before Codex have none: Claude. */
export type Agent = 'claude' | 'codex'
export const AGENTS: readonly Agent[] = ['claude', 'codex']

export function isAgent(v: unknown): v is Agent {
  return typeof v === 'string' && (AGENTS as readonly string[]).includes(v)
}

/** What runs a turn: Claude Code or Codex, on its own models or a local one. */
export type TurnEngineKey = 'claude' | 'local' | 'codex' | 'codexLocal'

/** Which engine runs a model for an agent; null when the agent can't run that model (Claude models in Codex). */
export function turnEngine(agent: Agent, engine: Engine): TurnEngineKey | null {
  if (engine === 'local') return agent === 'codex' ? 'codexLocal' : 'local'
  return engine === agent ? engine : null
}

/** Which agent's session a turn engine keeps. */
export function agentOfEngine(key: TurnEngineKey): Agent {
  return key === 'codex' || key === 'codexLocal' ? 'codex' : 'claude'
}

export interface ModelOption {
  /** "claude:opus", "codex:gpt-6.1-sol" or "local:<LiteLLM model name>". */
  id: string
  label: string
  hint: string
  /** Claude and Codex models take an effort level. */
  efforts: boolean
  /** A local model that can't call tools: it only chats (no files, commands or folder). */
  chatOnly?: boolean
}

export interface ModelGroup {
  /** e.g. "Claude · your subscription", "GPU box". */
  title: string
  engine: Engine
  online: boolean
  models: ModelOption[]
}

/** `alias` is what the CLI's --model takes. Fable goes by full id: the CLI's "fable" alias is Fable 5.1. */
export const CLAUDE_MODELS: readonly { alias: string; family: string; hint: string }[] = [
  { alias: 'opus', family: 'Opus', hint: 'Strong all-rounder, the default' },
  { alias: 'claude-fable-5-2', family: 'Fable 5.2', hint: 'Most capable: hardest problems, long multi-step work' },
  { alias: 'claude-fable-5', family: 'Fable 5', hint: 'Previous top model, deep reasoning' },
  { alias: 'sonnet', family: 'Sonnet', hint: 'Fast everyday work and coding' },
  { alias: 'haiku', family: 'Haiku', hint: 'Quickest and lightest, simple tasks' },
]

/** Codex's models (as Codex 0.166 lists them), the default first. They need Codex signed in to OpenAI. */
export const CODEX_MODELS: readonly { id: string; label: string; hint: string }[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', hint: 'Latest workhorse for coding and everyday work, the default' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', hint: 'Frontier intelligence for the most demanding work' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', hint: 'Balanced, for straightforward work' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', hint: 'Fast and light, easier tasks' },
]

export const DEFAULT_ASSISTANT_MODEL = 'claude:opus'
export const DEFAULT_CODEX_MODEL = `codex:${CODEX_MODELS[0]!.id}`

export function parseModelId(id: string): { engine: Engine; name: string } | null {
  const m = /^(claude|local|codex):(.+)$/.exec(id)
  if (!m) return null
  if (m[1] === 'claude' && !CLAUDE_MODELS.some((c) => c.alias === m[2])) return null
  if (m[1] === 'codex' && !CODEX_MODELS.some((c) => c.id === m[2])) return null
  return { engine: m[1] as Engine, name: m[2]! }
}

/** Whether an agent is there to pick, and whether its own models can run (signed in). */
export interface AgentStatus {
  installed: boolean
  signedIn: boolean
  /** From the agent's own CLI, when it's installed. */
  version?: string | null
  /** The command the hub runs. */
  path?: string | null
  /** Installed by Limeade (in its folder), so Limeade can update it. */
  managed?: boolean
  /** How it's signed in: 'subscription', 'console', 'api-key' or 'chatgpt'. */
  how?: string | null
  account?: string | null
}

/** Codex's own models: offline (shown, not pickable) until Codex is signed in. */
export function codexGroup(status: AgentStatus): ModelGroup {
  return {
    title: !status.signedIn ? 'Codex · not signed in' : status.how === 'api-key' ? 'Codex · your API key' : 'Codex · your OpenAI sign-in',
    engine: 'codex',
    online: status.signedIn,
    models: CODEX_MODELS.map((c) => ({ id: `codex:${c.id}`, label: c.label, hint: c.hint, efforts: true })),
  }
}

/** "claude-opus-5-5" -> "Opus 5.5"; null when it isn't a Claude model id. */
export function claudeLabel(modelId: string): string | null {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(modelId)
  if (!m) return null
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

/**
 * Claude group, labelled with the versions the CLI last reported (alias -> model id). Offline (shown, not
 * pickable) while Claude Code isn't installed or signed in, when the hub knows.
 */
export function claudeGroup(seen: Readonly<Record<string, string>>, status?: AgentStatus): ModelGroup {
  const title = !status ? 'Claude · your subscription'
    : !status.installed ? 'Claude · not installed'
    : !status.signedIn ? 'Claude · not signed in'
    : status.how === 'api-key' ? 'Claude · your API key'
    : status.how === 'console' ? 'Claude · your Console account'
    : 'Claude · your subscription'
  return {
    title,
    engine: 'claude',
    online: !status || (status.installed && status.signedIn),
    models: CLAUDE_MODELS.map((c) => ({
      id: `claude:${c.alias}`,
      label: (seen[c.alias] && claudeLabel(seen[c.alias]!)) || c.family,
      hint: c.hint,
      efforts: true,
    })),
  }
}

/** Local models get only the latest stretch of a long thread (the Assistant's runs to hundreds of messages). */
export const LOCAL_HISTORY = 40

export function historyFor<T>(engine: Engine, history: readonly T[]): readonly T[] {
  return engine === 'local' && history.length > LOCAL_HISTORY ? history.slice(-LOCAL_HISTORY) : history
}

export interface LocalModel {
  name: string
  machine: string
  hint: string
  online: boolean
  /** False when the model can't call tools (LiteLLM model_info.tools: false). */
  tools: boolean
}

/**
 * A LiteLLM model name as people say it: "llama3.1-8b" -> "Llama 3.1 8B", "qwen2.5-7b" -> "Qwen 2.5 7B",
 * "mac-llama3.1-8b" -> "Llama 3.1 8B · Mac". Names that don't fit the pattern stay as they are.
 */
export function localLabel(name: string): string {
  const mac = /^mac-/i.test(name)
  const parts = (mac ? name.slice(4) : name).split(/[-_:]/)
  const words: string[] = []
  for (const p of parts) {
    const fam = /^([a-z]+)(\d+(?:\.\d+)*)?$/i.exec(p)
    const size = /^(\d+(?:\.\d+)?)([bmk])$/i.exec(p)
    if (size) words.push(size[1]! + size[2]!.toUpperCase())
    else if (fam) words.push(fam[1]!.charAt(0).toUpperCase() + fam[1]!.slice(1), ...(fam[2] ? [fam[2]] : []))
    else if (/^\d+(?:\.\d+)*$/.test(p)) words.push(p)
    else return name
  }
  return words.join(' ') + (mac ? ' · Mac' : '')
}

/** Local models grouped by machine, in the order the machines first appear. */
export function localGroups(models: readonly LocalModel[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>()
  for (const m of models) {
    let g = groups.get(m.machine)
    if (!g) {
      g = { title: m.machine, engine: 'local', online: false, models: [] }
      groups.set(m.machine, g)
    }
    g.online ||= m.online
    g.models.push({ id: `local:${m.name}`, label: localLabel(m.name), hint: m.hint, efforts: false, ...(m.tools ? {} : { chatOnly: true }) })
  }
  return [...groups.values()]
}

export function agentLabel(agent: Agent): string {
  return agent === 'codex' ? 'Codex' : 'Claude Code'
}
