// API keys Limeade keeps for the agents (work: an Anthropic or OpenAI key). On a Mac they go in the login
// Keychain (service "Limeade"); elsewhere in a 0600 file in the hub's config folder. Never in a repo or an
// agent's config file; they reach the agent as an environment variable when it starts.

import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SecretStore } from '../ports.ts'

export class KeyFile implements SecretStore {
  private file: string
  constructor(file: string) {
    this.file = file
  }

  private read(): Record<string, string> {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8'))
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  }

  private write(all: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }

  async get(name: string): Promise<string | null> {
    return this.read()[name] ?? null
  }

  async set(name: string, value: string): Promise<void> {
    this.write({ ...this.read(), [name]: value })
  }

  async remove(name: string): Promise<void> {
    const all = this.read()
    delete all[name]
    this.write(all)
  }
}

const SERVICE = 'Limeade'

/** A `security -i` command line; the value is quoted for its parser (keys are printable ASCII). */
export function keychainAddCommand(name: string, value: string): string {
  const q = (s: string) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`
  return `add-generic-password -U -s ${q(SERVICE)} -a ${q(name)} -w ${q(value)}\n`
}

/** macOS Keychain through `security`. The value goes in on stdin (interactive mode), never on the command line. */
export class Keychain implements SecretStore {
  private bin: string
  constructor(bin = '/usr/bin/security') {
    this.bin = bin
  }

  get(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(this.bin, ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], (err, stdout) => resolve(err ? null : stdout.replace(/\n$/, '') || null))
    })
  }

  set(name: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (d) => (err += d))
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain said no: ${err.trim().slice(0, 200) || `exit ${code}`}`))))
      child.stdin.end(keychainAddCommand(name, value))
    })
  }

  remove(name: string): Promise<void> {
    return new Promise((resolve) => {
      execFile(this.bin, ['delete-generic-password', '-s', SERVICE, '-a', name], () => resolve())
    })
  }
}
