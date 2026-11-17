// What Claude Code and Codex each have set up (skills, agents, MCP servers), side by side, and what it
// takes to give both the same. One shared form per kind:
// - a skill is a folder with a SKILL.md (the same in both agents);
// - an agent (persona) is a name, a description and instructions (Claude: agents/<id>.md, Codex:
//   agents/<id>.toml);
// - an MCP server is Claude's JSON shape, where a key is a "${NAME}" reference to Limeade's key store,
//   never the key itself.

export type Side = 'claude' | 'codex'
export const SIDES: readonly Side[] = ['claude', 'codex']
export type Kind = 'skill' | 'agent' | 'mcp'

export const otherSide = (s: Side): Side => (s === 'claude' ? 'codex' : 'claude')
export const sideName = (s: Side): string => (s === 'claude' ? 'Claude Code' : 'Codex')

export const validId = (id: string): boolean => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)
export const validKeyName = (name: string): boolean => /^[A-Z_][A-Z0-9_]{0,63}$/.test(name)

// ---------- frontmatter (skills and Claude agents) ----------

/** Top-level `key: value` pairs from YAML-ish frontmatter, including `|` and `>` blocks. */
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  const lines = m[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    let value = kv[2]!.trim()
    if (/^[|>][-+]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1]!)) block.push(lines[++i]!.trim())
      value = block.join(' ').trim()
    } else if (/^"(.*)"$/.test(value)) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    } else {
      // Folded plain scalars continue on more-indented lines.
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && !/^\s+[A-Za-z_-]+:\s/.test(lines[i + 1]!)) value += ' ' + lines[++i]!.trim()
      value = value.replace(/^'|'$/g, '')
    }
    out[kv[1]!] = value
  }
  return out
}

/** The text after the frontmatter. */
export function body(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (m ? text.slice(m[0].length) : text).trim()
}

// ---------- agents (personas) ----------

export interface Persona {
  name: string
  description: string
  instructions: string
}

export function personaFromMarkdown(id: string, text: string): Persona {
  const fm = frontmatter(text)
  return { name: fm.name || id, description: fm.description ?? '', instructions: body(text) }
}

/** A Claude agent file for a persona that came from Codex. Strings are JSON-quoted, which YAML reads as is. */
export function personaMarkdown(p: Persona): string {
  return `---\nname: ${JSON.stringify(p.name)}\ndescription: ${JSON.stringify(p.description)}\n---\n\n${p.instructions.trim()}\n`
}

/** Codex agent names allow letters, digits, spaces, hyphens and underscores. */
export function codexAgentName(name: string, id: string): string {
  const clean = name.replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().replace(/\s+/g, ' ')
  return clean || id
}

const squash = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim()

export function samePersona(a: Persona, b: Persona): boolean {
  return squash(a.description) === squash(b.description) && squash(a.instructions) === squash(b.instructions)
}

// ---------- MCP servers ----------

/** Claude's shape: stdio {command,args,env} or http/sse {url,headers,headersHelper}. Keys are "${NAME}". */
export interface McpServer {
  type?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  headersHelper?: string
  [more: string]: unknown
}

export const isRemote = (s: McpServer): boolean => typeof s.url === 'string'

const REF = /^\$\{([A-Z_][A-Z0-9_]*)\}$/
const BEARER_REF = /^Bearer \$\{([A-Z_][A-Z0-9_]*)\}$/

/** The key names a server refers to. */
export function keysUsed(s: McpServer): string[] {
  const names = new Set<string>()
  for (const v of [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})]) {
    for (const m of String(v).matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) names.add(m[1]!)
  }
  return [...names].sort()
}

/**
 * Every env and header value that isn't already a key reference moves to the key store: an env value
 * under its own name, a header under <SERVER>_<HEADER> (a bearer token keeps "Bearer " in the config).
 * Env and header values are treated as keys because they usually are (Toolbox hid them for the same reason).
 */
export function liftKeys(id: string, s: McpServer, known: Readonly<Record<string, string>>): { server: McpServer; keys: Record<string, string> } {
  const out = structuredClone(s)
  const keys: Record<string, string> = {}
  const taken = (name: string, value: string) => (known[name] !== undefined && known[name] !== value) || (keys[name] !== undefined && keys[name] !== value)
  const prefix = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^(?=[0-9])/, '_')
  for (const [k, v] of Object.entries(out.env ?? {})) {
    if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(v)) continue
    const name = validKeyName(k) ? k : `${prefix}_${k.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
    // Codex hands a stdio server keys by their own name, so a clash can't be renamed away.
    if (taken(name, v)) throw new Error(`The key ${name} is already set to something else; use "\${OTHER_NAME}" for ${id}'s ${k}`)
    keys[name] = v
    out.env![k] = `\${${name}}`
  }
  for (const [h, v] of Object.entries(out.headers ?? {})) {
    if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(v)) continue
    const bearer = /^Bearer (.+)$/.exec(v)
    let name = `${prefix}_${bearer ? 'TOKEN' : h.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
    for (let n = 2; taken(name, bearer ? bearer[1]! : v); n++) name = `${name.replace(/_\d+$/, '')}_${n}`
    keys[name] = bearer ? bearer[1]! : v
    out.headers![h] = bearer ? `Bearer \${${name}}` : `\${${name}}`
  }
  return { server: out, keys }
}

/** How a key still written in a config shows on screen (it never leaves the computer). */
export const HIDDEN = '<hidden>'

const isRefOnly = (v: string) => /\$\{[A-Z_][A-Z0-9_]*\}/.test(v)

/** The server with every env and header value that is still a literal (not a "${NAME}") hidden, and which. */
export function maskLiterals(s: McpServer): { server: McpServer; hidden: string[] } {
  const out = structuredClone(s)
  const hidden: string[] = []
  for (const field of ['env', 'headers'] as const) {
    for (const [k, v] of Object.entries(out[field] ?? {})) {
      if (isRefOnly(String(v))) continue
      out[field]![k] = HIDDEN
      hidden.push(field === 'env' ? k : `${k} header`)
    }
  }
  return { server: out, hidden }
}

/** Hidden values back from the saved server, so an edit never has to retype them. */
export function unmaskLiterals(s: McpServer, original: McpServer | undefined): McpServer {
  const out = structuredClone(s)
  for (const field of ['env', 'headers'] as const) {
    for (const [k, v] of Object.entries(out[field] ?? {})) {
      if (v !== HIDDEN) continue
      const was = original?.[field]?.[k]
      if (was === undefined) throw new Error(`No saved value for ${k}: type the real value instead of ${HIDDEN}`)
      out[field]![k] = was
    }
  }
  return out
}

/** What Codex can't do with this server, or null. */
export function codexCannot(s: McpServer): string | null {
  if (s.type === 'sse') return "Codex can't use SSE servers"
  for (const [k, v] of Object.entries(s.env ?? {})) {
    const ref = REF.exec(v)
    if (ref && ref[1] !== k) return `Codex passes keys by their own name: ${k} would need to be "\${${k}}"`
    if (!ref && /\$\{/.test(v)) return `Codex can't build ${k} from a key; it must be exactly "\${${k}}"`
  }
  for (const [h, v] of Object.entries(s.headers ?? {})) {
    if (/\$\{/.test(v) && !REF.test(v) && !(h.toLowerCase() === 'authorization' && BEARER_REF.test(v))) return `Codex can't build the ${h} header from a key`
  }
  return null
}

/** The server as Codex's config.toml table ([mcp_servers.<id>]), with keys as environment variable names. */
export function toCodexMcp(s: McpServer): Record<string, unknown> {
  const why = codexCannot(s)
  if (why) throw new Error(why)
  if (!isRemote(s)) {
    const env: Record<string, string> = {}
    const envVars: string[] = []
    for (const [k, v] of Object.entries(s.env ?? {})) REF.test(v) ? envVars.push(k) : (env[k] = v)
    return {
      command: s.command,
      ...(s.args?.length ? { args: s.args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(envVars.length ? { env_vars: envVars } : {}),
    }
  }
  const t: Record<string, unknown> = { url: s.url }
  const plain: Record<string, string> = {}
  const fromEnv: Record<string, string> = {}
  for (const [h, v] of Object.entries(s.headers ?? {})) {
    const bearer = h.toLowerCase() === 'authorization' ? BEARER_REF.exec(v) : null
    const ref = REF.exec(v)
    if (bearer) t.bearer_token_env_var = bearer[1]
    else if (ref) fromEnv[h] = ref[1]!
    else plain[h] = v
  }
  if (Object.keys(plain).length) t.http_headers = plain
  if (Object.keys(fromEnv).length) t.env_http_headers = fromEnv
  if (s.headersHelper) t.http_headers_helper = s.headersHelper
  return t
}

/** One server from `codex mcp list --json` in the shared shape. */
export function fromCodexMcp(entry: any): McpServer {
  const t = entry?.transport ?? {}
  if (t.type === 'stdio') {
    const env: Record<string, string> = { ...(t.env ?? {}) }
    for (const k of t.env_vars ?? []) env[typeof k === 'string' ? k : String(k?.name)] = `\${${typeof k === 'string' ? k : k?.name}}`
    return { type: 'stdio', command: t.command, ...(t.args?.length ? { args: t.args } : {}), ...(Object.keys(env).length ? { env } : {}) }
  }
  const headers: Record<string, string> = { ...(t.http_headers ?? {}) }
  for (const [h, name] of Object.entries(t.env_http_headers ?? {})) headers[h] = `\${${name}}`
  if (t.bearer_token_env_var) headers.Authorization = `Bearer \${${t.bearer_token_env_var}}`
  return {
    type: 'http',
    url: t.url,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(typeof t.http_headers_helper === 'string' && t.http_headers_helper !== '<redacted>' ? { headersHelper: t.http_headers_helper } : {}),
  }
}

/** The same server, comparing keys by their values where the store has them. */
export function sameMcp(a: McpServer, b: McpServer, keys: Readonly<Record<string, string>>): boolean {
  const norm = (s: McpServer) => {
    const resolve = (v: string) => v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (all, n: string) => keys[n] ?? all)
    const map = (r?: Record<string, string>) => (r && Object.keys(r).length ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), resolve(v)]).sort()) : undefined)
    return JSON.stringify({
      remote: isRemote(s),
      type: isRemote(s) ? (s.type === 'sse' ? 'sse' : 'http') : 'stdio',
      command: s.command,
      args: s.args?.length ? s.args : undefined,
      env: map(s.env),
      url: s.url,
      headers: map(s.headers),
      helper: s.headersHelper,
    })
  }
  return norm(a) === norm(b)
}

export function describeMcp(s: McpServer): string {
  if (isRemote(s)) return `${s.type ?? 'http'} · ${s.url}`
  return [s.command, ...(s.args ?? [])].join(' ')
}

// ---------- side by side, and the mirror plan ----------

/** One item as one agent has it. `fingerprint` is equal when the content is (skills: the folder). */
export interface Found {
  id: string
  name: string
  description: string
  /** Skills: the real folder (two sides on one folder are one skill). */
  realPath?: string
  /** Codex agents kept in another app's markdown, which Codex itself doesn't load. */
  notLoaded?: string
}

export interface Pair<T extends Found = Found> {
  id: string
  claude?: T
  codex?: T
}

export type Step =
  | { action: 'same' }
  | { action: 'copy'; from: Side }
  | { action: 'choose'; why: string }
  | { action: 'cannot'; why: string }

/**
 * What mirroring does with one item: nothing when both agree, copy it to the side that hasn't got it,
 * or ask which to keep when they differ. `same` compares two sides that both have it; `cannot` says why
 * a side can't take it (null when it can).
 */
export function stepFor<T extends Found>(pair: Pair<T>, same: (a: T, b: T) => boolean, cannot: (from: Side, item: T) => string | null = () => null): Step {
  const { claude, codex } = pair
  if (claude && codex) {
    if (codex.notLoaded) return same(claude, codex) ? { action: 'copy', from: 'claude' } : { action: 'choose', why: 'They differ' }
    return same(claude, codex) ? { action: 'same' } : { action: 'choose', why: 'They differ' }
  }
  const from: Side = claude ? 'claude' : 'codex'
  const why = cannot(from, (claude ?? codex)!)
  return why ? { action: 'cannot', why } : { action: 'copy', from }
}

export function pairUp<T extends Found>(claude: readonly T[], codex: readonly T[]): Pair<T>[] {
  const out = new Map<string, Pair<T>>()
  for (const it of claude) out.set(it.id, { id: it.id, claude: it })
  for (const it of codex) out.set(it.id, { ...(out.get(it.id) ?? { id: it.id }), codex: it })
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** "claude", "codex" or "both": who has an item, for the list's tag. */
export function whoHas(p: Pair): 'claude' | 'codex' | 'both' {
  if (p.claude && p.codex && !p.codex.notLoaded) return 'both'
  return p.claude ? 'claude' : 'codex'
}
