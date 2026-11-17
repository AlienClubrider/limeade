// Local models through the LiteLLM proxy on this box: the model list (grouped by machine), plain chats for
// models that can't call tools, and one-shot drafts. Models that can call tools run in Claude Code (or
// Codex) instead.

import { localGroups, type LocalModel, type ModelGroup } from '../domain/models.ts'
import type { LocalModels, OneShot, TurnEngine, TurnRequest, TurnResult } from '../ports.ts'

export interface LiteLlmOptions {
  url: string // e.g. http://127.0.0.1:4000
  key?: string | null
  /** How long a machine's online check is trusted. */
  probeTtlMs?: number
  fetch?: typeof fetch
}

export class LiteLlm implements TurnEngine, LocalModels, OneShot {
  private o: LiteLlmOptions
  private probes = new Map<string, { at: number; online: boolean }>()
  private f: typeof fetch

  constructor(o: LiteLlmOptions) {
    this.o = o
    this.f = o.fetch ?? fetch
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.o.key ? { Authorization: `Bearer ${this.o.key}` } : {}) }
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    if (req.attachments?.length) return { text: '', sessionId: null, error: "this model only chats and can't take files; pick another model" }
    const messages = [
      ...req.history.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text })),
      { role: 'user', content: req.prompt },
    ]
    let text = ''
    try {
      const r = await this.f(`${this.o.url}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: req.model, messages, stream: true }),
        signal: req.signal,
      })
      if (!r.ok || !r.body) {
        const body: any = await r.json().catch(() => null)
        const why = body?.error?.message ?? `HTTP ${r.status}`
        return { text: '', sessionId: null, error: offlineHint(String(why)) }
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
    const r = await this.f(`${this.o.url}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model,
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

  async groups(): Promise<ModelGroup[]> {
    const r = await this.f(`${this.o.url}/v1/model/info`, { headers: this.headers(), signal: AbortSignal.timeout(4000) }).catch(() => null)
    const body: any = r?.ok ? await r.json().catch(() => null) : null
    const rows: any[] = Array.isArray(body?.data) ? body.data : []
    const models: LocalModel[] = await Promise.all(
      rows.map(async (row) => {
        const info = row.model_info ?? {}
        const probe = typeof info.probe === 'string' ? info.probe : row.litellm_params?.api_base
        return {
          name: String(row.model_name),
          machine: String(info.machine ?? 'This server'),
          hint: String(info.hint ?? ''),
          tools: info.tools !== false,
          online: typeof probe === 'string' ? await this.isUp(probe) : true,
        }
      }),
    )
    return localGroups(models)
  }

  /** Whether a model can call tools (model_info.tools isn't false). Unknown models are assumed to. */
  async usesTools(model: string): Promise<boolean> {
    const now = Date.now()
    if (!this.toolsInfo || now - this.toolsInfo.at > 60_000) {
      const r = await this.f(`${this.o.url}/v1/model/info`, { headers: this.headers(), signal: AbortSignal.timeout(4000) }).catch(() => null)
      const body: any = r?.ok ? await r.json().catch(() => null) : null
      if (Array.isArray(body?.data)) {
        this.toolsInfo = { at: now, chatOnly: new Set(body.data.filter((row: any) => row.model_info?.tools === false).map((row: any) => String(row.model_name))) }
      }
    }
    return !this.toolsInfo?.chatOnly.has(model)
  }

  private toolsInfo: { at: number; chatOnly: Set<string> } | null = null

  /**
   * Which Ollama machine and model a local model's name is (from the entry the hub generated), so Codex
   * can talk to Ollama itself. Null when LiteLLM doesn't have it.
   */
  async ollamaModel(name: string): Promise<{ url: string; tag: string; machine: string } | null> {
    const r = await this.f(`${this.o.url}/v1/model/info`, { headers: this.headers(), signal: AbortSignal.timeout(4000) }).catch(() => null)
    const body: any = r?.ok ? await r.json().catch(() => null) : null
    const row = Array.isArray(body?.data) ? body.data.find((x: any) => x?.model_name === name) : null
    const info = row?.model_info ?? {}
    const url = typeof info.probe === 'string' ? info.probe : row?.litellm_params?.api_base
    const tag = typeof info.ollama === 'string' ? info.ollama : String(row?.litellm_params?.model ?? '').replace(/^ollama(_chat)?\//, '')
    if (typeof url !== 'string' || !url || !tag) return null
    return { url, tag, machine: String(info.machine ?? 'this server') }
  }

  /** LiteLLM has a new model list: ask again next time. */
  forget(): void {
    this.toolsInfo = null
  }

  /** Ollama answers /api/tags quickly when it's up; a short timeout keeps the picker snappy. */
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
  return /ECONNREFUSED|fetch failed|connect|timed? ?out/i.test(why) ? `the model's machine isn't answering (${why.slice(0, 120)})` : why.slice(0, 300)
}
