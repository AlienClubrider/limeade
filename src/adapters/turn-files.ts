// The files in a kept turn's folder, shared by the hub (claude-cli.ts, acp-turns.ts) and the keepers
// (turn-keeper.ts, acp-keeper.ts).

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const KEEPER_FILES = {
  first: 'first.json',
  out: 'out.jsonl',
  answered: 'answered.jsonl',
  err: 'err.log',
  exit: 'exit.json',
  collected: 'collected',
  socket: 'in.sock',
  /** Settings for a local model's turn (claude-cli.ts). */
  settings: 'settings.json',
  /**
   * Ids of his messages handed to the running turn (steering), one JSON line each, so a new hub knows
   * which ones the agent hasn't taken in yet. The hub makes it empty when the turn starts: a turn without
   * it was started by an older hub whose keeper can't steer.
   */
  steers: 'steers.jsonl',
} as const

/** Marks a new turn's folder as one that takes messages mid-turn. */
export function allowSteers(dir: string): void {
  writeFileSync(join(dir, KEEPER_FILES.steers), '', { mode: 0o600 })
}

/** The steered messages' ids so far; null when the turn can't be steered (an older keeper). */
export function steerIds(dir: string): string[] | null {
  let text: string
  try {
    text = readFileSync(join(dir, KEEPER_FILES.steers), 'utf8')
  } catch {
    return null
  }
  const ids: string[] = []
  for (const line of text.split('\n')) {
    try {
      const id = JSON.parse(line).id
      if (typeof id === 'string') ids.push(id)
    } catch {}
  }
  return ids
}

/** Notes a message handed to the running turn, before it's sent, so a restart can't lose track of it. */
export function recordSteer(dir: string, id: string): void {
  appendFileSync(join(dir, KEEPER_FILES.steers), JSON.stringify({ id }) + '\n', { mode: 0o600 })
}
