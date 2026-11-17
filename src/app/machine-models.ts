// Local models on the user's machines: what each has, the Ollama library to add from, pulls with live
// progress (one per machine, only when he asks), removal, and keeping LiteLLM's list in step so the
// picker shows exactly what's installed.

import { EventEmitter } from 'node:events'
import { HubError } from './conversations.ts'
import {
  PullProgress, canChat, estimateBytes, fitLabel, fitOf, fullTag, goodFor, isEmbedding, isModelRef, modelFamily, modelList, notedEntries, pickerName, sizeLabel, usersOf,
  usesTools, type InstalledModel, type LiteLlmEntry, type ModelNotes, type ModelUser, type OllamaMachine,
} from '../domain/local-models.ts'
import type { RestartGate } from '../domain/restart-gate.ts'
import type { LibrarySource, LiteLlmModelsFile, OllamaApi } from '../ports.ts'

export interface PullState {
  machine: string
  tag: string
  state: 'pulling' | 'done' | 'failed' | 'cancelled'
  status: string
  completed: number
  total: number
  percent: number
  error?: string
}

interface Deps {
  machines: readonly OllamaMachine[]
  notes: ModelNotes
  ollama: OllamaApi
  library: LibrarySource
  file: LiteLlmModelsFile
  gate: RestartGate
  /** Called after LiteLLM has a new list (e.g. to drop cached model info). */
  reloaded?: () => void
  log?: (line: string) => void
  /** How often pull progress goes out. */
  progressMs?: number
  /** Things outside the hub that use models by name (a search tool's embeddings), and how to read their config. */
  users?: readonly ModelUser[]
  readText?: (path: string) => Promise<string | null>
}

/**
 * Events:
 *  'pull'          PullState                       progress, then done / failed / cancelled
 *  'local_models'  { machine?: string }            installed models or LiteLLM's list changed
 */
export class MachineModels extends EventEmitter {
  private d: Deps
  private pulls = new Map<string, { state: PullState; ctl: AbortController }>()
  private last = new Map<string, PullState>()
  private syncing: Promise<void> = Promise.resolve()

  constructor(d: Deps) {
    super()
    this.d = d
  }

  private machine(id: unknown): OllamaMachine {
    const m = this.d.machines.find((x) => x.id === id)
    if (!m) throw new HubError(404, 'No such machine')
    return m
  }

  private view(m: OllamaMachine, models: readonly InstalledModel[] | null, users: readonly { name: string; machine?: string; text: string }[] = [], descriptions: ReadonlyMap<string, string> = new Map()) {
    const listed = (models ?? []).filter((x) => canChat(x) || isEmbedding(x))
    const used = listed.reduce((n, x) => n + x.size, 0)
    return {
      id: m.id,
      label: m.label,
      short: m.short,
      online: models !== null,
      /** GPU memory (GB) a model can use on this machine. */
      memoryGb: m.maxGb,
      /** Disk used by its chat and embedding models, "15 GB" ('' when none or offline). */
      installedLabel: used ? sizeLabel(used) : '',
      models: [...listed]
        .sort((a, b) => a.tag.localeCompare(b.tag))
        .map((x) => {
          const note = this.d.notes[m.id]?.[x.tag]
          return {
            tag: x.tag,
            name: pickerName(m, x.tag, note),
            size: x.size,
            sizeLabel: x.size ? sizeLabel(x.size) : '',
            parameterSize: x.parameterSize,
            kind: isEmbedding(x) ? ('embedding' as const) : ('chat' as const),
            tools: !isEmbedding(x) && usesTools(x, note),
            fit: fitLabel(fitOf(x.size, m), m),
            /** "Coding and file work": what it's good for, in a few words. */
            goodFor: goodFor(x.tag, { note, parameterSize: x.parameterSize, description: descriptions.get(modelFamily(x.tag)) }),
            /** e.g. a search tool: outside users whose config names this model; removing it breaks them. */
            usedBy: usersOf(m.id, x.tag, users),
          }
        }),
      pull: this.pulls.get(m.id)?.state ?? this.last.get(m.id) ?? null,
    }
  }

  /** Each machine: up or not, its chat and embedding models, and its pull (running or the last one). */
  async overview() {
    const [users, descriptions] = await Promise.all([this.userConfigs(), this.descriptions()])
    return { machines: await Promise.all(this.d.machines.map(async (m) => this.view(m, await this.d.ollama.installed(m), users, descriptions))) }
  }

  /**
   * Library descriptions by family, for models the hints table doesn't know. Waits at most a couple of
   * seconds for ollama.com the first time; without them those models just have no "good for" line.
   */
  private async descriptions(): Promise<Map<string, string>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2_000) })
    const lib = await Promise.race([this.d.library.models().catch(() => null), late]).finally(() => clearTimeout(timer))
    return new Map((lib?.models ?? []).map((x) => [x.name, x.description]))
  }

  /** Each outside user's config files as one text; a file that can't be read counts as empty. */
  private async userConfigs() {
    const read = this.d.readText
    if (!read) return []
    return Promise.all((this.d.users ?? []).map(async (u) => ({
      name: u.name,
      machine: u.machine,
      text: (await Promise.all(u.files.map((f) => read(f).catch(() => null)))).join('\n'),
    })))
  }

  /** The library with a fit hint per machine for each size (estimated from the size tag). */
  async library() {
    const { models, fetchedAt, fallback } = await this.d.library.models()
    return {
      fetchedAt,
      fallback,
      models: models.map((x) => ({
        ...x,
        /** From the hints table only: the description is already shown beside it. */
        goodFor: goodFor(x.name) || null,
        sizes: x.sizes.map((s) => {
          const bytes = estimateBytes(s)
          return { size: s, about: bytes, fits: bytes === null ? {} : this.fits(bytes) }
        }),
      })),
    }
  }

  /** One library model's tags with download sizes and fit per machine. */
  async tags(name: unknown) {
    if (!isModelRef(name) || String(name).includes(':')) throw new HubError(400, 'Not a model name')
    const tags = await this.d.library.tags(name)
    return { name, tags: tags.map((t) => ({ ...t, sizeLabel: t.bytes ? sizeLabel(t.bytes) : '', fits: t.bytes ? this.fits(t.bytes) : {} })) }
  }

  private fits(bytes: number): Record<string, { fit: string; label: string }> {
    const out: Record<string, { fit: string; label: string }> = {}
    for (const m of this.d.machines) {
      const fit = fitOf(bytes, m)
      out[m.id] = { fit, label: fitLabel(fit, m) }
    }
    return out
  }

  /** Starts pulling a model on a machine (the user tapped Add). One pull per machine at a time. */
  pull(machineId: unknown, ref: unknown): PullState {
    const m = this.machine(machineId)
    if (!isModelRef(ref)) throw new HubError(400, 'Not a model name')
    if (this.pulls.has(m.id)) throw new HubError(409, `${m.label} is already downloading ${this.pulls.get(m.id)!.state.tag}`)
    const tag = fullTag(ref)
    const ctl = new AbortController()
    const state: PullState = { machine: m.id, tag, state: 'pulling', status: 'starting', completed: 0, total: 0, percent: 0 }
    this.pulls.set(m.id, { state, ctl })
    this.last.delete(m.id)
    this.d.log?.(`model pull started: ${tag} on ${m.label}`)
    this.emit('pull', { ...state })
    void this.runPull(m, state, ctl)
    return { ...state }
  }

  private async runPull(m: OllamaMachine, state: PullState, ctl: AbortController): Promise<void> {
    const progress = new PullProgress()
    let sentAt = 0
    try {
      await this.d.ollama.pull(m, state.tag, ctl.signal, (line) => {
        progress.add(line)
        Object.assign(state, { status: progress.status, completed: progress.completed, total: progress.total, percent: progress.percent })
        const now = Date.now()
        if (now - sentAt >= (this.d.progressMs ?? 500)) {
          sentAt = now
          this.emit('pull', { ...state })
        }
      })
      if (progress.status !== 'success') throw new Error(`${m.label} stopped answering before the download finished`)
      state.state = 'done'
      state.percent = 100
      state.completed = state.total
    } catch (err) {
      state.state = ctl.signal.aborted ? 'cancelled' : 'failed'
      if (!ctl.signal.aborted) state.error = (err as Error).message.slice(0, 300)
    } finally {
      this.pulls.delete(m.id)
      this.last.set(m.id, state)
      this.d.log?.(`model pull ${state.state}: ${state.tag} on ${m.label}${state.error ? ` (${state.error})` : ''}`)
      this.emit('pull', { ...state })
    }
    if (state.state === 'done') await this.sync().catch(() => {})
  }

  cancel(machineId: unknown): boolean {
    const p = this.pulls.get(this.machine(machineId).id)
    if (!p) return false
    p.ctl.abort()
    return true
  }

  /** Removes an installed model from a machine (the user confirmed), then from the picker. */
  async remove(machineId: unknown, tag: unknown): Promise<void> {
    const m = this.machine(machineId)
    if (!isModelRef(tag)) throw new HubError(400, 'Not a model name')
    const installed = await this.d.ollama.installed(m)
    if (!installed) throw new HubError(503, `${m.label} isn't answering`)
    if (!installed.some((x) => x.tag === tag)) throw new HubError(404, `${tag} isn't on ${m.label}`)
    if (this.pulls.get(m.id)?.state.tag === tag) throw new HubError(409, `${tag} is still downloading`)
    try {
      await this.d.ollama.remove(m, tag)
    } catch (err) {
      throw new HubError(502, (err as Error).message)
    }
    this.d.log?.(`model removed: ${tag} on ${m.label}`)
    this.emit('local_models', { machine: m.id })
    await this.sync()
  }

  /**
   * Rebuilds LiteLLM's local-model list from what each machine has (a machine that doesn't answer keeps its
   * entries) and restarts LiteLLM between turns when the list changed. Calls run one after another.
   */
  sync(): Promise<void> {
    const run = this.syncing.then(() => this.syncNow())
    this.syncing = run.catch(() => {})
    return run
  }

  private async syncNow(): Promise<void> {
    const current = await this.d.file.read()
    const previous: readonly LiteLlmEntry[] = current ?? notedEntries(this.d.machines, this.d.notes)
    const installed = new Map(await Promise.all(this.d.machines.map(async (m) => [m.id, await this.d.ollama.installed(m)] as const)))
    const next = modelList(this.d.machines, installed, this.d.notes, previous, await this.descriptions())
    if (current && JSON.stringify(current) === JSON.stringify(next)) return
    await this.d.file.write(next)
    this.d.log?.(`local models: ${next.length}; reloading the list between turns`)
    try {
      await this.d.gate.restart(() => this.d.file.restart())
    } catch (err) {
      this.d.log?.(`litellm restart failed: ${(err as Error).message}`)
      throw err
    }
    this.d.reloaded?.()
    this.emit('local_models', {})
  }
}
