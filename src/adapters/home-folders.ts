// The home folder on this box, for picking a chat's working folder. Every path is checked against its
// real location (symlinks followed) and must stay inside home.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { folderPath, insideHome, isClutter, matchesSearch } from '../domain/places.ts'
import type { HomeFolders } from '../ports.ts'

export class HomeFolderTree implements HomeFolders {
  readonly home: string
  private realHome: Promise<string>
  private maxDepth: number
  private maxVisits: number

  constructor(home: string, opts: { maxDepth?: number; maxVisits?: number } = {}) {
    this.home = home
    this.realHome = fs.realpath(home).catch(() => home)
    this.maxDepth = opts.maxDepth ?? 4
    this.maxVisits = opts.maxVisits ?? 4000
  }

  async resolve(path: string): Promise<string | null> {
    const asked = folderPath(this.home, path)
    if (!asked) return null
    try {
      const real = await fs.realpath(asked)
      const home = await this.realHome
      if (!insideHome(home, real)) return null
      if (!(await fs.stat(real)).isDirectory()) return null
      // Keep the user's spelling of home (it may itself be a link) so paths read as ~/…
      return home === this.home ? real : join(this.home, real.slice(home.length))
    } catch {
      return null
    }
  }

  async list(path: string, opts: { hidden?: boolean } = {}): Promise<string[]> {
    const dir = await this.resolve(path)
    if (!dir) return []
    return this.children(dir, opts.hidden ?? false)
  }

  async search(query: string, limit = 40): Promise<string[]> {
    if (!query.trim()) return []
    const found: string[] = []
    let visits = 0
    // Breadth first, so ~/dev/x comes before ~/dev/x/y/z.
    let level = [this.home]
    for (let depth = 0; depth < this.maxDepth && level.length && found.length < limit; depth++) {
      const next: string[] = []
      for (const dir of level) {
        if (++visits > this.maxVisits) return found
        for (const child of await this.children(dir, false)) {
          if (matchesSearch(this.home, child, query)) {
            found.push(child)
            if (found.length >= limit) return found
          }
          next.push(child)
        }
      }
      level = next
    }
    return found
  }

  /** Real folders only: symlinked folders are listed only when they point back inside home. */
  private async children(dir: string, hidden: boolean): Promise<string[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: string[] = []
    for (const e of entries) {
      if (!hidden && isClutter(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(p)
      else if (e.isSymbolicLink() && (await this.resolve(p))) out.push(p)
    }
    return out.sort((a, b) => a.localeCompare(b))
  }
}
