// The bits of TOML Limeade writes for Codex: an agent file (~/.codex/agents/<id>.toml) and one
// [mcp_servers.<id>] table in ~/.codex/config.toml. Edits replace only what Limeade owns, so the rest of
// a file (comments, other settings) stays exactly as it was. Codex itself reads the result back
// (`codex mcp get`) before a change counts, so a mistake here can't leave a broken config behind.

const BARE = /^[A-Za-z0-9_-]+$/

export const tomlKey = (k: string): string => (BARE.test(k) ? k : JSON.stringify(k))

/** A TOML string: a ''' block for multi-line text when it can be one, else a basic string (JSON's escapes are TOML's). */
export function tomlString(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (s.includes('\n') && !s.includes("'''") && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s) && !s.endsWith("'")) return `'''\n${s}'''`
  return JSON.stringify(s)
}

export function tomlValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(', ')} }`
  throw new Error(`Can't write ${typeof v} to TOML`)
}

export function mcpTable(id: string, t: Record<string, unknown>): string {
  const lines = Object.entries(t).filter(([, v]) => v !== undefined).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)
  return `[mcp_servers.${tomlKey(id)}]\n${lines.join('\n')}\n`
}

/** A table header's dotted key, e.g. `[mcp_servers."a b".env]` -> ['mcp_servers', 'a b', 'env']. */
function headerPath(line: string): string[] | null {
  const m = /^\s*\[(?!\[)(.*)\]\s*(#.*)?$/.exec(line)
  if (!m) return null
  const out: string[] = []
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y
  let pos = 0
  const s = m[1]!
  while (pos < s.length) {
    re.lastIndex = pos
    const k = re.exec(s)
    if (!k) return null
    out.push(k[1] !== undefined ? JSON.parse(`"${k[1]}"`) : (k[2] ?? k[3])!)
    pos = re.lastIndex
  }
  return out
}

/** The config without [mcp_servers.<id>] and its sub-tables. */
export function withoutMcpTable(text: string, id: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let dropping = false
  for (const line of lines) {
    const path = /^\s*\[/.test(line) ? headerPath(line) : null
    if (path) dropping = path[0] === 'mcp_servers' && path[1] === id
    if (!dropping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** A string in [mcp_servers.<id>] (Codex's own listing hides some, e.g. http_headers_helper). */
export function mcpTableString(text: string, id: string, key: string): string | undefined {
  const out: string[] = []
  let inside = false
  for (const line of text.split('\n')) {
    const path = /^\s*\[/.test(line) ? headerPath(line) : null
    if (path) {
      inside = path.length === 2 && path[0] === 'mcp_servers' && path[1] === id
      continue
    }
    if (inside) out.push(line)
  }
  return topEntries(out.join('\n')).find((e) => e.key === key)?.value
}

export function withMcpTable(text: string, id: string, t: Record<string, unknown>): string {
  const base = withoutMcpTable(text, id).replace(/\s*$/, '')
  return `${base ? base + '\n\n' : ''}${mcpTable(id, t)}`
}

// ---------- agent files ----------

interface Entry {
  key: string
  /** The string value, when the value is a string. */
  value?: string
  start: number
  end: number
}

/** Top-level `key = value` entries before the first table, with where each sits in the text. */
function topEntries(text: string): Entry[] {
  const out: Entry[] = []
  let i = 0
  const n = text.length
  const skipLine = () => {
    while (i < n && text[i] !== '\n') i++
    if (i < n) i++
  }
  while (i < n) {
    const lineStart = i
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++
    if (i >= n) break
    const c = text[i]
    if (c === '\n') { i++; continue }
    if (c === '#') { skipLine(); continue }
    if (c === '[') break // tables: not ours
    const km = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*=\s*/.exec(text.slice(i))
    if (!km) { skipLine(); continue }
    const key = km[1] !== undefined ? JSON.parse(`"${km[1]}"`) : (km[2] ?? km[3])!
    i += km[0].length
    const { value, end } = readValue(text, i)
    i = end
    skipLine()
    out.push({ key, ...(value !== undefined ? { value } : {}), start: lineStart, end: i })
  }
  return out
}

function readValue(text: string, i: number): { value?: string; end: number } {
  const rest = text.slice(i)
  for (const q of ['"""', "'''"]) {
    if (rest.startsWith(q)) {
      const close = text.indexOf(q, i + 3)
      if (close < 0) throw new Error('Unclosed multi-line string')
      let end = close + 3
      while (text[end] === q[0]) end++ // up to two quotes may belong to the string
      let raw = text.slice(i + 3, end - 3)
      if (raw.startsWith('\r\n')) raw = raw.slice(2)
      else if (raw.startsWith('\n')) raw = raw.slice(1)
      if (q === '"""') raw = unescapeBasic(raw.replace(/\\\r?\n\s*/g, ''))
      return { value: raw, end }
    }
  }
  if (rest[0] === '"') {
    const m = /^"((?:[^"\\\n]|\\.)*)"/.exec(rest)
    if (!m) throw new Error('Bad string')
    return { value: unescapeBasic(m[1]!), end: i + m[0].length }
  }
  if (rest[0] === "'") {
    const m = /^'([^'\n]*)'/.exec(rest)
    if (!m) throw new Error('Bad string')
    return { value: m[1]!, end: i + m[0].length }
  }
  // Anything else: skip to the end of the value (arrays and inline tables can span lines).
  let depth = 0
  let j = i
  while (j < text.length) {
    const c = text[j]!
    if (c === '"' || c === "'") {
      const q = text.startsWith(c.repeat(3), j) ? c.repeat(3) : c
      const close = text.indexOf(q, j + q.length)
      j = close < 0 ? text.length : close + q.length
      continue
    }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === '#' && depth === 0) break
    else if (c === '\n' && depth <= 0) break
    j++
  }
  return { end: j }
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16))
    return ({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\u001b' } as Record<string, string>)[e] ?? e
  })
}

const MANAGED = ['name', 'description', 'developer_instructions']

/** A Codex agent file's name, description and instructions (the parts Limeade shows and shares). */
export function readCodexAgent(text: string): { name: string; description: string; instructions: string } {
  const get = (k: string) => topEntries(text).find((e) => e.key === k)?.value ?? ''
  return { name: get('name'), description: get('description'), instructions: get('developer_instructions') }
}

/** The agent file with new name, description and instructions; any other settings in it stay. */
export function writeCodexAgent(old: string, p: { name: string; description: string; instructions: string }): string {
  let rest = old
  for (const e of topEntries(old).filter((e) => MANAGED.includes(e.key)).reverse()) rest = rest.slice(0, e.start) + rest.slice(e.end)
  const head = `name = ${JSON.stringify(p.name)}\ndescription = ${JSON.stringify(p.description)}\ndeveloper_instructions = ${tomlString(p.instructions.trim() + '\n')}\n`
  rest = rest.replace(/^\s+/, '')
  return rest ? `${head}${/^\[/.test(rest) ? '\n' : ''}${rest}` : head
}
