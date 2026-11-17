// Abuse limits for the public endpoint. Time is injected so the rules are testable.

import { timingSafeEqual, createHash } from 'node:crypto'

/** Constant-time key check (hashing first makes lengths equal). */
export function keyMatches(given: string | undefined, want: string): boolean {
  if (!given) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(want).digest()
  return timingSafeEqual(a, b)
}

/** Bans a client after too many failed key checks inside a window. */
export class FailedAuthBan {
  private fails = new Map<string, number[]>()
  private bannedUntil = new Map<string, number>()
  private maxFails: number
  private windowMs: number
  private banMs: number
  private now: () => number

  constructor(opts: { maxFails: number; windowMs: number; banMs: number; now: () => number }) {
    this.maxFails = opts.maxFails
    this.windowMs = opts.windowMs
    this.banMs = opts.banMs
    this.now = opts.now
  }

  isBanned(client: string): boolean {
    const until = this.bannedUntil.get(client)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.bannedUntil.delete(client)
    return false
  }

  recordFailure(client: string): void {
    const t = this.now()
    const recent = (this.fails.get(client) ?? []).filter((x) => t - x < this.windowMs)
    recent.push(t)
    if (recent.length >= this.maxFails) {
      this.bannedUntil.set(client, t + this.banMs)
      this.fails.delete(client)
    } else {
      this.fails.set(client, recent)
    }
  }
}

/** At most `max` events in any sliding `windowMs`. */
export class SlidingWindowLimit {
  private hits: number[] = []
  private max: number
  private windowMs: number
  private now: () => number

  constructor(opts: { max: number; windowMs: number; now: () => number }) {
    this.max = opts.max
    this.windowMs = opts.windowMs
    this.now = opts.now
  }

  tryTake(): boolean {
    const t = this.now()
    this.hits = this.hits.filter((x) => t - x < this.windowMs)
    if (this.hits.length >= this.max) return false
    this.hits.push(t)
    return true
  }
}
