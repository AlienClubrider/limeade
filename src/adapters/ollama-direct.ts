// Local models straight from one Ollama (a fresh install's setup; no LiteLLM in between). The model list is
// built the same way as LiteLLM's (names, hints, tool verdicts), kept in a small file here instead of
// LiteLLM's config, so nothing needs restarting. Plain chats for models that can't call tools go to Ollama's
// OpenAI-style API; models with tools run in Claude Code against Ollama's own Anthropic-style API, or in Codex.

import { readFile, rename, writeFile } from 'node:fs/promises'
import { localGroups, type LocalModel, type ModelGroup } from '../domain/models.ts'
import type { LiteLlmEntry } from '../domain/local-models.ts'
import type { LiteLlmModelsFile, LocalModels, OneShot, TurnEngine, TurnRequest, TurnResult } from '../ports.ts'

export interface OllamaDirectOptions {
  /** Where the list is kept between restarts. */
  file: string
  fetch?: typeof fetch
  probeTtlMs?: number
}

export class OllamaDirect implements LiteLlmModelsFile, LocalModels, TurnEngine, OneShot {
  private o: OllamaDirectOptions
  private f: typeof fetch
  private entries: LiteLlmEntry[] | null = null
  private loaded: Promise<void>
  private probes = new Map<string, { at: number; online: boolean }>()

  constructor(o: OllamaDirectOptions) {
    this.o = o
    this.f = o.fetch ?? fetch
    this.loaded = readFile(o.file, 'utf8')
      .then((t) => {
        const list = JSON.parse(t)
        if (Array.isArray(list)) this.entries = list
      })
      .catch(() => {})
  }

  // ---------- the list (MachineModels writes it after each look at Ollama) ----------

  async read(): Promise<LiteLlmEntry[] | null> {
    await this.loaded
    return this.entries
  }

  async write(entries: readonly LiteLlmEntry[]): Promise<void> {
    this.entries = [...entries]
    const tmp = `${this.o.file}.tmp`
    await writeFile(tmp, JSON.stringify(entries), { mode: 0o600 })
    await rename(tmp, this.o.file)
  }

  /** Nothing to restart: the next request reads the new list. */
  async restart(): Promise<void> {}

  private entry(name: string): LiteLlmEntry | undefined {
    return this.entries?.find((e) => e.model_name === name)
  }

  /** Ollama's tag for a picker name ("gemma4-26b" -> "gemma4:26b"); the name itself when unknown. */
  tagFor(name: string): string {
    return this.entry(name)?.model_info.ollama || name
  }

  // ---------- LocalModels and what the engines ask ----------

  async groups(): Promise<ModelGroup[]> {
    await this.loaded
    const models: LocalModel[] = await Promise.all(
      (this.entries ?? []).map(async (e) => ({
        name: e.model_name,
        machine: e.model_info.machine,
        hint: e.model_info.hint,
        tools: e.model_info.tools !== false,
        online: await this.isUp(e.model_info.probe),
      })),
    )
    return localGroups(models)
  }

  async usesTools(model: string): Promise<boolean> {
    await this.loaded
    return this.entry(model)?.model_info.tools !== false
  }

  async ollamaModel(name: string): Promise<{ url: string; tag: string; machine: string } | null> {
    await this.loaded
    const e = this.entry(name)
    return e ? { url: e.model_info.probe, tag: e.model_info.ollama, machine: e.model_info.machine } : null
  }

  forget(): void {}

  // ---------- plain chats and one-shot drafts (OpenAI-style API on Ollama) ----------

  private target(model: string): { url: string; tag: string } {
    const e = this.entry(model)
    if (!e) throw new Error(`${model} isn't on this computer's Ollama any more; pick another model`)
    return { url: e.model_info.probe.replace(/\/$/, ''), tag: e.model_info.ollama }
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    if (req.attachments?.length) return { text: '', sessionId: null, error: "this model only chats and can't take files; pick another model" }
    await this.loaded
    let t: { url: string; tag: string }
    try {
      t = this.target(req.model)
    } catch (err) {
      return { text: '', sessionId: null, error: (err as Error).message }
    }
    const messages = [
      ...req.history.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text })),
      { role: 'user', content: req.prompt },
    ]
    let text = ''
    try {
      const r = await this.f(`${t.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: t.tag, messages, stream: true }),
        signal: req.signal,
      })
      if (!r.ok || !r.body) {
        const body: any = await r.json().catch(() => null)
        return { text: '', sessionId: null, error: offlineHint(String(body?.error?.message ?? `HTTP ${r.status}`)) }
      }
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta) {
              text += delta
              req.onEvent({ type: 'text', text: delta })
            }
          } catch {}
        }
      }
      return { text, sessionId: null }
    } catch (err) {
      if (req.signal.aborted) return { text, sessionId: null }
      return { text, sessionId: null, error: offlineHint((err as Error).message) }
    }
  }

  async complete(req: Parameters<OneShot['complete']>[0]): Promise<string> {
    await this.loaded
    const t = this.target(req.model)
    const r = await this.f(`${t.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: t.tag,
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }],
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(240_000),
    }).catch((e: Error) => {
      throw new Error(offlineHint(e.message))
    })
    const body: any = await r.json().catch(() => null)
    if (!r.ok) throw new Error(offlineHint(String(body?.error?.message ?? `HTTP ${r.status}`)))
    return String(body?.choices?.[0]?.message?.content ?? '')
  }

  private async isUp(base: string): Promise<boolean> {
    const now = Date.now()
    const cached = this.probes.get(base)
    if (cached && now - cached.at < (this.o.probeTtlMs ?? 30_000)) return cached.online
    const online = await this.f(`${base.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false)
    this.probes.set(base, { at: now, online })
    return online
  }
}

function offlineHint(why: string): string {
  return /ECONNREFUSED|fetch failed|connect|timed? ?out/i.test(why) ? `Ollama isn't answering (${why.slice(0, 120)})` : why.slice(0, 300)
}
