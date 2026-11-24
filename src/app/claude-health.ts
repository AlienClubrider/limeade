// Keeps an eye on Claude's two credentials (the login, and the long-lived token background runs use) and
// gets the user to sign in again the moment one stops working: one bell item and one notification, straight
// from the hub, because the Assistant runs on the very login that may be broken. When the sign-in is back,
// the monitor runs that failed on it run again and the Assistant hears about it (to resume workers).

import { EventEmitter } from 'node:events'
import {
  alertText, failed as failedOn, probed, setupTokenFrom, START, tokenDaysLeft, tokenEndsOn,
  type AuthFailure, type Change, type ClaudeHealth as Health, type Credential, type ProbeOutcome,
} from '../domain/claude-health.ts'

interface Deps {
  probe: { run(token: string | null): Promise<{ outcome: ProbeOutcome; detail: string }> }
  tokenFile: { read(): { token: string; madeOn: string | null } | null; write(token: string, madeOn: string): void }
  store: { read(): Saved | null; write(s: Saved): void }
  /** The bell: one item while something needs the user (null clears it), and a one-off reminder. */
  bell: { signIn(a: { title: string; body: string } | null): Promise<void>; remind(title: string, body: string): Promise<void> }
  /** Runs a monitor again after the sign-in is back. */
  retryMonitor: (id: string) => Promise<void>
  /** Tells the Assistant (a fleet event). */
  news: (text: string) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

interface Saved {
  health: Health
  /** The token (by its made-on date) already warned about running out. */
  warnedFor?: string | null
}

export interface ClaudeHealthView {
  login: { state: Health['login']['state']; checkedAt: string | null; failed: string[] }
  token: { state: Health['token']['state']; checkedAt: string | null; failed: string[]; madeOn: string | null; endsOn: string | null; daysLeft: number | null }
  checking: boolean
}

const WARN_DAYS = 30

/** Emits 'claude_health' with the view whenever it changes. */
export class ClaudeHealth extends EventEmitter {
  private d: Deps
  private s: Saved
  private running: Promise<void> | null = null
  private lastCheck = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(d: Deps) {
    super()
    this.d = d
    this.s = d.store.read() ?? { health: START }
  }

  private now() {
    return this.d.now?.() ?? Date.now()
  }

  private say(line: string) {
    ;(this.d.log ?? console.log)(line)
  }

  view(): ClaudeHealthView {
    const h = this.s.health
    const t = this.d.tokenFile.read()
    const madeOn = t?.madeOn ?? null
    return {
      login: { state: h.login.state, checkedAt: h.login.checkedAt, failed: h.login.failed.map((f) => f.what) },
      token: {
        state: t ? h.token.state : 'none',
        checkedAt: h.token.checkedAt,
        failed: h.token.failed.map((f) => f.what),
        madeOn,
        endsOn: madeOn ? tokenEndsOn(madeOn) : null,
        daysLeft: tokenDaysLeft(madeOn, this.now()),
      },
      checking: !!this.running,
    }
  }

  /** Checks now, and every `everyMs` after (default 6 hours). */
  start(everyMs = 6 * 60 * 60_000): void {
    void this.check()
    this.timer ??= setInterval(() => void this.check(), everyMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Probes both credentials. `soft`: skipped when the last check was under a minute ago (Settings opening). */
  check(soft = false): Promise<void> {
    if (this.running) return this.running
    if (soft && this.now() - this.lastCheck < 60_000) return Promise.resolve()
    this.lastCheck = this.now()
    this.running = this.probeBoth().finally(() => {
      this.running = null
      this.emit('claude_health', this.view())
    })
    this.emit('claude_health', this.view())
    return this.running
  }

  private async probeBoth(): Promise<void> {
    const login = await this.d.probe.run(null)
    if (login.outcome === 'other') this.say(`claude sign-in check: couldn't tell (${login.detail.split('\n').at(-1) ?? ''})`)
    await this.apply('login', (h, at) => probed(h, 'login', login.outcome, at))
    const t = this.d.tokenFile.read()
    const token = t ? await this.d.probe.run(t.token) : { outcome: 'none' as const, detail: '' }
    await this.apply('token', (h, at) => probed(h, 'token', token.outcome, at))
    await this.expiryReminder()
  }

  /**
   * Something failed with an auth error. `background`: whatever background runs use (the token when there
   * is one, else the login).
   */
  async reported(cred: Credential | 'background', f: Omit<AuthFailure, 'at'>): Promise<void> {
    const which: Credential = cred === 'background' ? (this.d.tokenFile.read() ? 'token' : 'login') : cred
    this.say(`claude ${which} failed: ${f.what}`)
    await this.apply(which, (h, at) => failedOn(h, which, { ...f, at }))
    this.emit('claude_health', this.view())
  }

  /** A finished `claude setup-token`: the token from its output goes to the token file. Throws when there's none. */
  saveToken(output: string): void {
    const token = setupTokenFrom(output)
    if (!token) throw new Error("The sign-in finished but Limeade couldn't find the token in what Claude printed. Start again.")
    this.d.tokenFile.write(token, new Date(this.now()).toISOString().slice(0, 10))
    this.s.warnedFor = null
    this.d.store.write(this.s)
  }

  private async apply(cred: Credential, step: (h: Health, at: string) => { health: Health; change: Change }): Promise<void> {
    const before = this.s.health
    const { health, change } = step(before, new Date(this.now()).toISOString())
    this.s = { ...this.s, health }
    this.d.store.write(this.s)
    if (change === 'fixed') await this.fixed(cred, before[cred].failed)
    // One bell item for both; it changes (or goes) with them. Notifies only when it's new.
    if (change) await this.d.bell.signIn(alertText(health)).catch((err) => this.say(`claude sign-in alert: ${(err as Error).message}`))
  }

  private async fixed(cred: Credential, failed: AuthFailure[]) {
    const monitors = [...new Set(failed.flatMap((f) => (f.monitorId ? [f.monitorId] : [])))]
    for (const id of monitors) await this.d.retryMonitor(id).catch((err) => this.say(`monitor ${id}: couldn't run again: ${(err as Error).message}`))
    const others = failed.filter((f) => !f.monitorId).map((f) => f.what)
    const parts = [
      cred === 'login' ? 'Claude sign-in is back (the user signed in again).' : "Claude's background token works again.",
      monitors.length ? `Monitors run again: ${monitors.join(', ')}.` : '',
      others.length ? `Also stopped on it earlier: ${others.join('; ')}. Resume or restart those if they're still needed.` : '',
    ]
    await this.d.news(parts.filter(Boolean).join(' ')).catch((err) => this.say(`claude sign-in news: ${(err as Error).message}`))
  }

  /** A month before the token runs out: one reminder per token. */
  private async expiryReminder() {
    const t = this.d.tokenFile.read()
    const left = tokenDaysLeft(t?.madeOn ?? null, this.now())
    if (!t?.madeOn || left === null || left > WARN_DAYS || this.s.warnedFor === t.madeOn) return
    this.s.warnedFor = t.madeOn
    this.d.store.write(this.s)
    const when = left <= 0 ? 'has run out' : `runs out on ${tokenEndsOn(t.madeOn)}`
    await this.d.bell.remind(`Claude's background token ${when}`, 'Renew it in Settings › Claude sign-in. It takes one sign-in.').catch(() => undefined)
  }
}
