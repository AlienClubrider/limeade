// Ollama models on the user's machines: which names are safe to pull, whether a model fits a machine, and
// the LiteLLM entries the picker is built from (one per installed chat model, hand-written notes kept).

/** One Ollama machine the hub may manage. Only machines in deploy/local-models.json; never a URL from a request. */
export interface OllamaMachine {
  id: string
  /** "GPU box": the picker's group title (LiteLLM model_info.machine). */
  label: string
  /** "GPU", "Mac": for fit hints ("Fits the Mac"). */
  short: string
  url: string
  /** Picker names on this machine start with this ("mac-"). */
  prefix: string
  /** A model this size (GB, download size) or smaller runs comfortably with a 32k context. */
  fitsGb: number
  /** Past this it won't fit in the machine's GPU memory at all. */
  maxGb: number
}

/** A hand-written note for a model on a machine: keeps its picker name, hint and tool verdict. */
export interface ModelNote {
  name?: string
  hint?: string
  tools?: boolean
}

/** machine id -> Ollama tag ("llama3.1:8b") -> note. */
export type ModelNotes = Readonly<Record<string, Readonly<Record<string, ModelNote>>>>

/** A model as Ollama lists it on a machine (/api/tags). */
export interface InstalledModel {
  tag: string
  size: number
  parameterSize: string
  /** Ollama's capabilities: "completion", "tools", "vision", "thinking", "embedding"… */
  capabilities: readonly string[]
}

/** "qwen3", "qwen3:8b", "library/qwen3:8b-q4_K_M", "user/model:tag". Lowercase names, no URLs or paths. */
const MODEL_REF = /^(?:[a-z0-9][a-z0-9._-]{0,62}\/)?[a-z0-9][a-z0-9._-]{0,62}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,62})?$/

export function isModelRef(name: unknown): name is string {
  return typeof name === 'string' && MODEL_REF.test(name) && !name.includes('..')
}

/** Ollama's own name for a ref: ":latest" added when no tag is given. */
export function fullTag(ref: string): string {
  return ref.includes(':') ? ref : `${ref}:latest`
}

export type Fit = 'fits' | 'tight' | 'too-big'

/** A machine whose memory isn't known (maxGb 0: Ollama on another computer) fits everything, unlabelled. */
export function fitOf(bytes: number, m: Pick<OllamaMachine, 'fitsGb' | 'maxGb'>): Fit {
  if (!m.maxGb) return 'fits'
  const gb = bytes / 1e9
  return gb <= m.fitsGb ? 'fits' : gb <= m.maxGb ? 'tight' : 'too-big'
}

export function fitLabel(fit: Fit, m: Pick<OllamaMachine, 'label' | 'short' | 'maxGb'>): string {
  if (!m.maxGb) return ''
  return fit === 'fits' ? `Fits the ${m.short}` : fit === 'tight' ? `Tight on the ${m.short}` : `Too big for ${m.label}`
}

/** Rough download size from a size tag ("8b", "1.7b", "135m", "e4b"): Ollama's default 4-bit builds run ~0.6 GB per billion. */
export function estimateBytes(sizeTag: string): number | null {
  const m = /^(?:e)?(\d+(?:\.\d+)?)([bm])$/i.exec(sizeTag.trim())
  if (!m) return null
  const billions = Number(m[1]) / (m[2]!.toLowerCase() === 'm' ? 1000 : 1)
  return Math.round(billions * 0.6e9 + 0.1e9)
}

/** "271MB", "4.7GB", "1.2TB" (from ollama.com) -> bytes. */
export function parseSize(text: string): number | null {
  const m = /^([\d.]+)\s*([KMGT]?)B$/i.exec(text.trim())
  if (!m) return null
  const mult = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]!.toUpperCase() as '' | 'K' | 'M' | 'G' | 'T']
  return Math.round(Number(m[1]) * mult)
}

export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

/** Chat models only: embedding models can't hold a conversation. */
export function canChat(m: Pick<InstalledModel, 'capabilities'>): boolean {
  return m.capabilities.length === 0 || m.capabilities.includes('completion')
}

/** Embedding models turn text into vectors for search tools (a search tool); they can't chat. */
export function isEmbedding(m: Pick<InstalledModel, 'capabilities'>): boolean {
  return !canChat(m) && m.capabilities.includes('embedding')
}

/** Something outside the hub that uses a model by name, found in its own config files (a search tool). */
export interface ModelUser {
  name: string
  /** Only models on this machine; any machine when left out. */
  machine?: string
  files: readonly string[]
}

const IDENT = '[A-Za-z0-9._/-]'

/** Whether config text names this Ollama tag; a bare name ("nomic-embed-text") means its ":latest". */
export function namesModel(text: string, tag: string): boolean {
  const colon = tag.lastIndexOf(':')
  const name = colon < 0 ? tag : tag.slice(0, colon)
  const want = colon < 0 ? 'latest' : tag.slice(colon + 1)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<!${IDENT})${escaped}(?::([A-Za-z0-9._-]+))?(?!${IDENT}|:)`, 'g')
  for (const m of text.matchAll(re)) if ((m[1] ?? 'latest') === want) return true
  return false
}

/** Names of the users whose config names this model on this machine. */
export function usersOf(machineId: string, tag: string, users: readonly { name: string; machine?: string; text: string }[]): string[] {
  return [...new Set(users.filter((u) => (!u.machine || u.machine === machineId) && namesModel(u.text, tag)).map((u) => u.name))]
}

/** Picker name for an Ollama tag: the note's name, else prefix + tag with ":latest" dropped and ":" as "-". */
export function pickerName(machine: Pick<OllamaMachine, 'prefix'>, tag: string, note?: ModelNote): string {
  if (note?.name) return note.name
  const short = tag.replace(/:latest$/, '').replace(/^library\//, '')
  return machine.prefix + short.replace(/[:/]/g, '-')
}

/** Family ("qwen2.5") -> what it's good for, and optionally what its small sizes (4B and under) are good for. */
const GOOD_FOR: Readonly<Record<string, readonly [string, string?]>> = {
  'gemma4': ['Everyday questions, writing, summaries', 'Quick, light tasks'],
  'gemma3': ['Everyday questions, writing, summaries', 'Quick, light tasks'],
  'gemma2': ['Everyday questions and writing', 'Quick, light tasks'],
  'qwen3.8': ['Strong all-rounder, reasoning', 'Quick, light tasks'],
  'qwen3': ['Strong all-rounder, reasoning', 'Quick, light tasks'],
  'qwen2.5': ['Good at code and lists', 'Quick, light tasks'],
  'qwen3-coder': ['Coding and file work'],
  'qwen2.5-coder': ['Coding and file work', 'Quick code fixes'],
  'devstral': ['Coding and file work'],
  'codellama': ['Writing and explaining code'],
  'deepseek-coder-v2': ['Coding and file work'],
  'starcoder2': ['Code completion'],
  'llama3.1': ['Simple chat'],
  'llama3.2': ['Simple chat', 'Fastest, simple tasks'],
  'llama3.3': ['General chat and writing'],
  'mistral': ['Simple chat'],
  'mistral-nemo': ['General chat, long documents'],
  'mistral-small': ['Strong all-rounder for its size'],
  'deepseek-r1': ['Step-by-step reasoning, maths', 'Quick reasoning, light tasks'],
  'qwq': ['Step-by-step reasoning, maths'],
  'magistral': ['Step-by-step reasoning'],
  'phi4': ['Reasoning and maths'],
  'phi4-mini': ['Quick, light tasks'],
  'phi3': ['Quick, light tasks'],
  'gpt-oss': ['Strong all-rounder, reasoning'],
  'granite3.3': ['Business writing and summaries', 'Quick, light tasks'],
  'smollm2': ['Tiny and fast, simple tasks'],
  'llava': ['Describing pictures'],
  'llama3.2-vision': ['Describing pictures'],
  'nomic-embed-text': ['Search embeddings'],
  'mxbai-embed-large': ['Search embeddings'],
  'bge-m3': ['Search embeddings, many languages'],
  'all-minilm': ['Small, fast search embeddings'],
  'snowflake-arctic-embed': ['Search embeddings'],
  'snowflake-arctic-embed2': ['Search embeddings, many languages'],
  'embeddinggemma': ['Search embeddings'],
  'qwen3-embedding': ['Search embeddings, many languages'],
}

/** "library/qwen2.5:7b" -> "qwen2.5"; "user/model:tag" -> "model". */
export function modelFamily(ref: string): string {
  return ref.replace(/:.*$/, '').replace(/^.*\//, '')
}

/** A library description cut to its first sentence and at most 8 words ("Meta's Llama 3.1."). */
export function shortDescription(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]$/, '').trim()
  const words = first.split(/\s+/).filter(Boolean)
  return words.length > 8 ? `${words.slice(0, 8).join(' ').replace(/[,;:]$/, '')}…` : words.join(' ')
}

/**
 * What a model is good for, in a few plain words: the note's hint (hand-written), else the built-in table by
 * family (small sizes get their own line), else a trimmed library description, else ''.
 */
export function goodFor(tag: string, o: { note?: ModelNote; parameterSize?: string; description?: string } = {}): string {
  if (o.note?.hint) return o.note.hint
  const known = GOOD_FOR[modelFamily(tag)]
  if (known) {
    const sizeTag = /:(?:e)?(\d+(?:\.\d+)?[bm])\b/i.exec(tag)?.[1] ?? o.parameterSize ?? ''
    const bytes = estimateBytes(sizeTag.toLowerCase())
    return known[1] && bytes !== null && bytes <= estimateBytes('4b')! ? known[1] : known[0]
  }
  return o.description ? shortDescription(o.description) : ''
}

/** Whether a model can call tools: the note decides when there is one (tested by hand), else Ollama's capabilities. */
export function usesTools(m: Pick<InstalledModel, 'capabilities'>, note?: ModelNote): boolean {
  return note?.tools ?? m.capabilities.includes('tools')
}

/** One LiteLLM model_list entry (written as JSON, which YAML reads as-is). */
export interface LiteLlmEntry {
  model_name: string
  litellm_params: Record<string, unknown>
  model_info: { machine: string; hint: string; probe: string; ollama: string; tools?: false; supports_function_calling?: true }
}

export function entryFor(machine: OllamaMachine, model: InstalledModel, note: ModelNote | undefined, name: string, description?: string): LiteLlmEntry {
  const tools = usesTools(model, note)
  const fit = fitOf(model.size, machine)
  const auto = [model.parameterSize, model.size ? sizeLabel(model.size) : ''].filter(Boolean).join(' · ')
  return {
    model_name: name,
    litellm_params: {
      model: `ollama_chat/${model.tag}`,
      api_base: machine.url,
      // Claude Code sends 11k-23k tokens per request; Ollama's default context would cut it off.
      num_ctx: 32768,
      // Ollama refuses Claude's thinking/effort params for models that don't think.
      additional_drop_params: ['thinking', 'reasoning_effort'],
    },
    model_info: {
      machine: machine.label,
      hint: [goodFor(model.tag, { note, parameterSize: model.parameterSize, description }), auto, fit === 'too-big' && auto ? 'slow here' : ''].filter(Boolean).join(' · '),
      probe: machine.url,
      ollama: model.tag,
      ...(tools ? { supports_function_calling: true as const } : { tools: false as const }),
    },
  }
}

/**
 * The local part of LiteLLM's model list. A machine that answered gets one entry per installed chat model;
 * a machine that didn't (the Mac asleep) keeps the entries it had, so a nap doesn't empty the picker.
 */
export function modelList(
  machines: readonly OllamaMachine[],
  installed: ReadonlyMap<string, readonly InstalledModel[] | null>,
  notes: ModelNotes,
  previous: readonly LiteLlmEntry[],
  /** Library descriptions by family ("qwen2.5"), for models the hints table doesn't know. */
  descriptions: ReadonlyMap<string, string> = new Map(),
): LiteLlmEntry[] {
  const out: LiteLlmEntry[] = []
  const taken = new Set<string>()
  for (const machine of machines) {
    const models = installed.get(machine.id)
    if (!models) {
      for (const e of previous) {
        if (e.model_info?.machine !== machine.label || taken.has(e.model_name)) continue
        taken.add(e.model_name)
        out.push(e)
      }
      continue
    }
    for (const model of [...models].sort((a, b) => a.tag.localeCompare(b.tag))) {
      if (!canChat(model)) continue
      const note = notes[machine.id]?.[model.tag]
      let name = pickerName(machine, model.tag, note)
      for (let i = 2; taken.has(name); i++) name = `${pickerName(machine, model.tag, note)}-${i}`
      taken.add(name)
      out.push(entryFor(machine, model, note, name, descriptions.get(modelFamily(model.tag))))
    }
  }
  return out
}

/** Entries for machines never seen yet: what the notes say is installed (the hand-written list before this). */
export function notedEntries(machines: readonly OllamaMachine[], notes: ModelNotes): LiteLlmEntry[] {
  const installed = new Map<string, InstalledModel[]>()
  for (const m of machines) {
    installed.set(m.id, Object.keys(notes[m.id] ?? {}).map((tag) => ({ tag, size: 0, parameterSize: '', capabilities: [] })))
  }
  return modelList(machines, installed, notes, [])
}

/** Download progress across an Ollama pull's layers ({digest, total, completed} lines). */
export class PullProgress {
  private layers = new Map<string, { total: number; completed: number }>()
  status = 'starting'

  add(line: { status?: unknown; digest?: unknown; total?: unknown; completed?: unknown }): void {
    if (typeof line.status === 'string') this.status = line.status
    if (typeof line.digest === 'string' && typeof line.total === 'number') {
      this.layers.set(line.digest, { total: line.total, completed: typeof line.completed === 'number' ? line.completed : 0 })
    }
  }

  get total(): number {
    let t = 0
    for (const l of this.layers.values()) t += l.total
    return t
  }

  get completed(): number {
    let c = 0
    for (const l of this.layers.values()) c += Math.min(l.completed, l.total)
    return c
  }

  get percent(): number {
    return this.total ? Math.floor((this.completed / this.total) * 100) : 0
  }
}

/** A clean http(s) base URL for Ollama ("localhost:11434" -> "http://localhost:11434"), or null. */
export function ollamaUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let raw = input.trim()
  if (!raw || raw.length > 300) return null
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`
  try {
    const u = new URL(raw)
    if (u.username || u.password || u.search || u.hash) return null
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}
