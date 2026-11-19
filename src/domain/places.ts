// Where a chat runs: which machine, and which folder on it. Claude chats run Claude Code with that
// folder as the working directory; local-model chats only talk. Pure rules, no I/O.

/** This computer's id in stored chats (the name it had first). */
export const DEFAULT_MACHINE = 'homelab'

export type MachineKind = 'this-box' | 'remote'

export interface Machine {
  id: string
  label: string
  kind: MachineKind
  /** Can chats run there now. */
  online: boolean
  /** Shown under the name when it can't be picked, e.g. "Needs setup". */
  note?: string
}

export interface Where {
  machine: string
  /** Absolute, resolved path on that machine. */
  folder: string
}

/** The machines a chat can run on: just this computer, by the name it's set up with. (A local model's machine is a model in the picker, not a place.) */
export function machines(label = 'This computer'): Machine[] {
  return [{ id: DEFAULT_MACHINE, label, kind: 'this-box', online: true }]
}


/** Folders the picker and search skip unless asked: hidden ones and tool/system clutter. */
const CLUTTER = new Set(['node_modules', '__pycache__', 'snap', 'venv', 'site-packages', 'lost+found'])

export function isClutter(name: string): boolean {
  return name.startsWith('.') || CLUTTER.has(name)
}

/**
 * Turns what the user typed or picked ("~/dev/x", "/home/me/dev/x", "dev/x") into an absolute path
 * inside `home`, or null. Any ".." segment is refused outright, before symlinks are even looked at
 * (the adapter then checks the real path stays inside too).
 */
export function folderPath(home: string, input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.length > 1024 || raw.includes('\0')) return null
  const root = trimSlash(home)
  let rest: string
  if (raw === '~' || raw === root) rest = ''
  else if (raw.startsWith('~/')) rest = raw.slice(2)
  else if (raw.startsWith(`${root}/`)) rest = raw.slice(root.length + 1)
  else if (raw.startsWith('/') || raw.startsWith('~')) return null
  else rest = raw
  const parts = rest.split('/').filter((p) => p && p !== '.')
  if (parts.some((p) => p === '..')) return null
  return parts.length ? `${root}/${parts.join('/')}` : root
}

/** A source reference: a file, and the line (and column) in it a link points at. */
export interface SourceRef {
  path: string
  line: number
  column?: number
}

/**
 * "Test.java:72" or "Test.java:72:5" as the file and its line, the way editors and compilers write
 * them; null when the path doesn't end in one. A file whose real name ends like that is the caller's
 * to try first.
 */
export function sourceRef(path: string): SourceRef | null {
  const m = /^(.*?[^/:]):(\d{1,9})(?::(\d{1,9}))?$/.exec(path)
  if (!m || !Number(m[2])) return null
  return { path: m[1]!, line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}) }
}

/** True when `path` is `home` or below it. */
export function insideHome(home: string, path: string): boolean {
  const root = trimSlash(home)
  return path === root || path.startsWith(`${root}/`)
}

/** "/home/me/dev/x" -> "~/dev/x" for chips and headers. */
export function displayFolder(home: string, path: string): string {
  const root = trimSlash(home)
  if (path === root) return '~'
  return path.startsWith(`${root}/`) ? `~/${path.slice(root.length + 1)}` : path
}

/** The folders of the most recently used chats, newest first, without repeats. */
export function recentFolders(chats: readonly { where?: Where; updatedAt: string }[], max = 6): string[] {
  const out: string[] = []
  for (const c of [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const f = c.where?.folder
    if (f && !out.includes(f)) out.push(f)
    if (out.length >= max) break
  }
  return out
}

/** Folder names that match a search: every word must appear, case-insensitively, in the path below home. */
export function matchesSearch(home: string, path: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return false
  const rel = displayFolder(home, path).toLowerCase()
  return words.every((w) => rel.includes(w))
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}
