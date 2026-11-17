// Ollama's HTTP API on one machine: what's installed, pull (streamed progress) and delete. No auth on
// the local network; the hub only ever talks to the machines it's set up with.

import type { InstalledModel, OllamaMachine } from '../domain/local-models.ts'
import type { OllamaApi } from '../ports.ts'

export class OllamaHttp implements OllamaApi {
  private f: typeof fetch
  constructor(f: typeof fetch = fetch) {
    this.f = f
  }

  private base(m: OllamaMachine): string {
    return m.url.replace(/\/$/, '')
  }

  /** Installed models, or null when the machine doesn't answer (off, asleep, off the network). */
  async installed(m: OllamaMachine): Promise<InstalledModel[] | null> {
    const r = await this.f(`${this.base(m)}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
    const body: any = r?.ok ? await r.json().catch(() => null) : null
    if (!Array.isArray(body?.models)) return null
    return Promise.all(
      body.models.map(async (row: any) => {
        const tag = String(row.name ?? row.model)
        const tagCaps = Array.isArray(row.capabilities) ? row.capabilities.map(String) : null
        let parameterSize = String(row.details?.parameter_size ?? '')
        // Older Ollama leaves capabilities out of /api/tags, and newer models leave parameter_size empty there;
        // /api/show has both, so ask it whenever either is missing (keeps the list consistent for every model).
        const show = !tagCaps || !parameterSize ? await this.show(m, tag) : null
        if (!parameterSize) parameterSize = show?.parameterSize ?? ''
        return { tag, size: Number(row.size) || 0, parameterSize, capabilities: tagCaps ?? show?.capabilities ?? [] }
      }),
    )
  }

  private async show(m: OllamaMachine, tag: string): Promise<{ capabilities: string[]; parameterSize: string } | null> {
    const r = await this.f(`${this.base(m)}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: tag }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null)
    const body: any = r?.ok ? await r.json().catch(() => null) : null
    if (!body) return null
    let parameterSize = String(body.details?.parameter_size ?? '')
    const count = Number(body.model_info?.['general.parameter_count'])
    if (!parameterSize && count > 0) parameterSize = count >= 1e9 ? `${(count / 1e9).toFixed(1)}B` : `${Math.round(count / 1e6)}M`
    return { capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [], parameterSize }
  }

  async pull(m: OllamaMachine, tag: string, signal: AbortSignal, onLine: (line: Record<string, unknown>) => void): Promise<void> {
    const r = await this.f(`${this.base(m)}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: tag, stream: true }),
      signal,
    })
    if (!r.ok || !r.body) {
      const body: any = await r.json().catch(() => null)
      throw new Error(String(body?.error ?? `${m.label} said ${r.status}`))
    }
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const text = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!text) continue
        let line: any
        try {
          line = JSON.parse(text)
        } catch {
          continue
        }
        if (typeof line?.error === 'string') throw new Error(line.error)
        onLine(line)
      }
    }
  }

  async remove(m: OllamaMachine, tag: string): Promise<void> {
    const r = await this.f(`${this.base(m)}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      // "model" for current Ollama, "name" for older ones.
      body: JSON.stringify({ model: tag, name: tag }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!r.ok) {
      const body: any = await r.json().catch(() => null)
      throw new Error(String(body?.error ?? `${m.label} said ${r.status}`))
    }
  }
}
