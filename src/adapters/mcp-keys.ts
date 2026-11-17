// Keys MCP servers need (a Datadog API key, a GitHub token), kept out of every config file in the same
// secret store as the agents' own API keys (agent-keys.ts: the macOS Keychain, elsewhere a 0600 file).
// The store can't list what it holds, so the names live in a small file next to the config; the values
// are loaded once at start and kept in memory, because every agent start needs them all.

import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { validKeyName } from '../domain/shared-config.ts'
import type { KeyStore, SecretStore } from '../ports.ts'

export class McpKeys implements KeyStore {
  private o: { store: SecretStore; namesFile: string }
  private cache: Record<string, string> = {}
  constructor(o: McpKeys['o']) {
    this.o = o
  }

  async load(): Promise<this> {
    let names: string[] = []
    try {
      names = JSON.parse(await readFile(this.o.namesFile, 'utf8')).names ?? []
    } catch {}
    for (const name of names) {
      const value = await this.o.store.get(name)
      if (value !== null) this.cache[name] = value // gone from the store: shows as not set
    }
    return this
  }

  values(): Record<string, string> {
    return { ...this.cache }
  }

  async set(name: string, value: string): Promise<void> {
    if (!validKeyName(name)) throw new Error('A key name is capital letters, digits and _ (like DD_API_KEY)')
    await this.o.store.set(name, value)
    this.cache[name] = value
    await this.saveNames()
  }

  async remove(name: string): Promise<void> {
    await this.o.store.remove(name)
    delete this.cache[name]
    await this.saveNames()
  }

  private async saveNames() {
    const tmp = `${this.o.namesFile}.tmp`
    await writeFile(tmp, JSON.stringify({ names: Object.keys(this.cache).sort() }, null, 2) + '\n', { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.o.namesFile)
  }
}
