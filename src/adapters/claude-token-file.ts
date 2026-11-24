// Claude's long-lived token for background runs: one private file (0600), `CLAUDE_CODE_OAUTH_TOKEN=…`, that a
// systemd unit can load as an EnvironmentFile, so other apps on the machine share it. Read on every use, so
// a renewed token needs no restart. The token never goes to a log.

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readTokenFile, tokenFileText } from '../domain/claude-health.ts'

export class ClaudeTokenFile {
  readonly path: string
  constructor(path: string) {
    this.path = path
  }

  read(): { token: string; madeOn: string | null } | null {
    try {
      return readTokenFile(readFileSync(this.path, 'utf8'))
    } catch {
      return null
    }
  }

  /** The environment a background run gets: the token, or nothing (it runs on the sign-in). */
  env(): Record<string, string> {
    const t = this.read()
    return t ? { CLAUDE_CODE_OAUTH_TOKEN: t.token } : {}
  }

  write(token: string, madeOn: string): void {
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, tokenFileText(token, madeOn), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.path)
  }
}
