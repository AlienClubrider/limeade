// The Ollama library (ollama.com/library), read by the hub, never the browser: the model list once a day
// (kept on disk), each model's tags and download sizes when the user opens it. A built-in list stands in when
// the site can't be read.

import { readFile, rename, writeFile } from 'node:fs/promises'
import { parseSize } from '../domain/local-models.ts'
import type { LibraryModel, LibrarySource, LibraryTag } from '../ports.ts'

const DAY = 24 * 3_600_000
const SITE = 'https://ollama.com'
/** Bumped when parseLibrary keeps different models, so a list saved by the old one is read again. 2: embedding models kept. */
const LIST_VERSION = 2

export class OllamaLibrary implements LibrarySource {
  private f: typeof fetch
  private file: string
  private now: () => number
  private list: { at: number; models: LibraryModel[]; fallback: boolean } | null = null
  private loading: Promise<void> | null = null
  private tagCache = new Map<string, { at: number; tags: LibraryTag[] }>()

  constructor(o: { file: string; fetch?: typeof fetch; now?: () => number }) {
    this.file = o.file
    this.f = o.fetch ?? fetch
    this.now = o.now ?? Date.now
  }

  async models(): Promise<{ models: LibraryModel[]; fetchedAt: number | null; fallback: boolean }> {
    if (!this.list) {
      try {
        const saved = JSON.parse(await readFile(this.file, 'utf8'))
        if (saved?.v === LIST_VERSION && Array.isArray(saved?.models) && saved.models.length) this.list = { at: Number(saved.at) || 0, models: saved.models, fallback: false }
      } catch {}
    }
    const stale = !this.list || this.list.fallback || this.now() - this.list.at > DAY
    if (stale) {
      this.loading ??= this.refresh().finally(() => (this.loading = null))
      // First time: wait for the site. After that: answer from the saved list and refresh behind it.
      if (!this.list || this.list.fallback) await this.loading
    }
    const l = this.list ?? { at: 0, models: FALLBACK, fallback: true }
    return { models: l.models, fetchedAt: l.fallback ? null : l.at, fallback: l.fallback }
  }

  private async refresh(): Promise<void> {
    try {
      const r = await this.f(`${SITE}/library`, { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) throw new Error(`ollama.com said ${r.status}`)
      const models = parseLibrary(await r.text())
      if (models.length < 10) throw new Error('ollama.com/library looks different; using the built-in list')
      this.list = { at: this.now(), models, fallback: false }
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, JSON.stringify({ v: LIST_VERSION, at: this.list.at, models }), { mode: 0o600 })
      await rename(tmp, this.file)
    } catch (err) {
      console.log(`ollama library: ${(err as Error).message}`)
      if (!this.list) this.list = { at: this.now(), models: FALLBACK, fallback: true }
    }
  }

  /** The model's main tags ("latest", "8b"…, no quantization variants) with download sizes. */
  async tags(name: string): Promise<LibraryTag[]> {
    const cached = this.tagCache.get(name)
    if (cached && this.now() - cached.at < DAY) return cached.tags
    const r = await this.f(`${SITE}/library/${encodeURIComponent(name)}/tags`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
    if (!r?.ok) {
      if (r?.status === 404) return []
      const known = FALLBACK.find((m) => m.name === name)
      return known ? known.sizes.map((s) => ({ tag: `${name}:${s}`, bytes: null, context: '' })) : []
    }
    const tags = parseTags(await r.text(), name)
    if (this.tagCache.size > 300) this.tagCache.clear()
    this.tagCache.set(name, { at: this.now(), tags })
    return tags
  }
}

const unescape = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").trim()

/** ollama.com/library: one <li> per model with its description, capability badges, size tags and pulls. */
export function parseLibrary(html: string): LibraryModel[] {
  const out: LibraryModel[] = []
  for (const item of html.split(/<li\b/).slice(1)) {
    const name = /href="\/library\/([a-z0-9][a-z0-9._-]*)"/.exec(item)?.[1]
    if (!name || out.some((m) => m.name === name)) continue
    const badges = [...item.matchAll(/text-(?:indigo|cyan)-\d00[^>]*>([^<]+)</g)].map((m) => m[1]!.trim())
    const sizes = [...item.matchAll(/text-blue-600[^>]*>([^<]+)</g)].map((m) => m[1]!.trim())
    const cloud = badges.includes('cloud')
    // Cloud-only models can't be pulled.
    if (cloud && !sizes.length) continue
    out.push({
      name,
      description: unescape(/<p class="max-w-lg[^"]*">([^<]*)<\/p>/.exec(item)?.[1] ?? ''),
      capabilities: badges.filter((b) => b !== 'cloud'),
      sizes,
      pulls: /<span\s*>([\d.]+[KMB]?)<\/span>\s*<span[^>]*>&nbsp;Pulls/.exec(item)?.[1] ?? '',
    })
  }
  return out
}

/** ollama.com/library/<name>/tags: each tag with its size; quantization variants and cloud tags left out. */
export function parseTags(html: string, name: string): LibraryTag[] {
  const out: LibraryTag[] = []
  const re = /<a href="\/library\/([^"]+)" class="md:hidden[\s\S]*?<\/span>\s*•\s*([\d.]+\s*[KMGT]?B)\s*•\s*([\dKM.]+) context window/g
  for (const m of html.matchAll(re)) {
    const tag = m[1]!
    if (!tag.startsWith(`${name}:`) || /cloud/.test(tag) || out.some((t) => t.tag === tag)) continue
    const variant = tag.slice(name.length + 1)
    if (variant !== 'latest' && variant.includes('-')) continue
    out.push({ tag, bytes: parseSize(m[2]!), context: m[3]! })
  }
  return out
}

/** Used only when ollama.com can't be read and nothing was saved: well-known chat models (sizes as tags). */
export const FALLBACK: LibraryModel[] = [
  ['qwen3', 'Qwen3: dense and mixture-of-experts models, good at code and reasoning.', ['tools', 'thinking'], ['0.6b', '1.7b', '4b', '8b', '14b', '30b', '32b']],
  ['qwen2.5', 'Qwen2.5: multilingual models with long context.', ['tools'], ['0.5b', '1.5b', '3b', '7b', '14b', '32b', '72b']],
  ['qwen2.5-coder', 'Qwen2.5 tuned for code generation and fixing.', ['tools'], ['0.5b', '1.5b', '3b', '7b', '14b', '32b']],
  ['llama3.1', "Meta's Llama 3.1.", ['tools'], ['8b', '70b']],
  ['llama3.2', "Meta's small Llama 3.2 models.", ['tools'], ['1b', '3b']],
  ['gemma3', "Google's Gemma 3, runs on one GPU.", ['vision'], ['270m', '1b', '4b', '12b', '27b']],
  ['mistral', 'Mistral 7B.', ['tools'], ['7b']],
  ['mistral-small', 'Mistral Small: strong for its size.', ['vision', 'tools'], ['22b', '24b']],
  ['deepseek-r1', 'DeepSeek-R1 reasoning models.', ['tools', 'thinking'], ['1.5b', '7b', '8b', '14b', '32b', '70b']],
  ['phi4', "Microsoft's Phi-4.", [], ['14b']],
  ['phi4-mini', "Microsoft's Phi-4 mini, with function calling.", ['tools'], ['3.8b']],
  ['gpt-oss', "OpenAI's open-weight models.", ['tools', 'thinking'], ['20b', '120b']],
  ['granite3.3', "IBM's Granite 3.3.", ['tools'], ['2b', '8b']],
  ['smollm2', 'SmolLM2: tiny models that run anywhere.', ['tools'], ['135m', '360m', '1.7b']],
].map(([name, description, capabilities, sizes]) => ({ name, description, capabilities, sizes, pulls: '' }) as LibraryModel)
