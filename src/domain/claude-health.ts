// Whether Claude's two credentials still work, and what to tell the user when one stops. Pure rules; the
// probes, the token file and the bell are elsewhere.
//
// - login: the CLI's own sign-in (`claude auth login`), shared by chats, workers and anything else that runs
//   `claude` as this user. Short-lived, refreshed by the CLI; when a refresh fails everything on it stops.
// - token: a long-lived (1-year) token from `claude setup-token`, inference only, kept in one file that
//   background runs (monitors, other apps' headless calls) load as CLAUDE_CODE_OAUTH_TOKEN.

import { plainText } from './agent-setup.ts'

export type Credential = 'login' | 'token'
/** none: no token file (the token is optional). unknown: not checked yet. */
export type CredState = 'ok' | 'needs-you' | 'unknown' | 'none'

/** Something that failed because a credential stopped working; monitor runs are run again afterwards. */
export interface AuthFailure {
  what: string
  at: string
  monitorId?: string
}

export interface CredHealth {
  state: CredState
  checkedAt: string | null
  failed: AuthFailure[]
}

export interface ClaudeHealth {
  login: CredHealth
  token: CredHealth & { madeOn: string | null }
}

/** What a probe found: it worked, it was refused for auth, there's no token, or something else went wrong. */
export type ProbeOutcome = 'ok' | 'auth' | 'none' | 'other'

/** broke: went to needs-you. fixed: came back from needs-you. */
export type Change = 'broke' | 'fixed' | null

const FRESH: CredHealth = { state: 'unknown', checkedAt: null, failed: [] }
export const START: ClaudeHealth = { login: { ...FRESH }, token: { ...FRESH, madeOn: null } }

const MAX_FAILED = 10

/** The CLI's words when a credential doesn't work (as opposed to a network or model error). */
const AUTH_FAILURE = /Failed to authenticate|OAuth (?:session|token) (?:has )?(?:expired|been revoked)|could not be refreshed|Authentication required|Please run \/login|Invalid bearer token|invalid x-api-key|authentication_error|Not logged in/i

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text)
}

function put(h: ClaudeHealth, cred: Credential, next: CredHealth): ClaudeHealth {
  return cred === 'login' ? { ...h, login: next } : { ...h, token: { ...h.token, ...next } }
}

function change(before: CredState, after: CredState): Change {
  if (after === 'needs-you' && before !== 'needs-you') return 'broke'
  if (before === 'needs-you' && (after === 'ok' || after === 'none')) return 'fixed'
  return null
}

/** A probe's result. 'other' (network down, a model error) changes nothing but the time. */
export function probed(h: ClaudeHealth, cred: Credential, outcome: ProbeOutcome, at: string): { health: ClaudeHealth; change: Change } {
  const was = h[cred]
  if (outcome === 'other') return { health: put(h, cred, { ...was, checkedAt: at }), change: null }
  const state: CredState = outcome === 'ok' ? 'ok' : outcome === 'none' ? 'none' : 'needs-you'
  const next: CredHealth = { state, checkedAt: at, failed: state === 'needs-you' ? was.failed : [] }
  return { health: put(h, cred, next), change: change(was.state, state) }
}

/** Something failed on a credential (a monitor run, a chat turn, another app): it needs the user now. */
export function failed(h: ClaudeHealth, cred: Credential, f: AuthFailure): { health: ClaudeHealth; change: Change } {
  const was = h[cred]
  const kept = was.failed.filter((x) => (f.monitorId ? x.monitorId !== f.monitorId : x.what !== f.what))
  const next: CredHealth = { state: 'needs-you', checkedAt: was.checkedAt, failed: [...kept, f].slice(-MAX_FAILED) }
  return { health: put(h, cred, next), change: change(was.state, 'needs-you') }
}

/** The one bell item (and notification) while anything needs the user; null when nothing does. */
export function alertText(h: ClaudeHealth): { title: string; body: string } | null {
  const login = h.login.state === 'needs-you'
  const token = h.token.state === 'needs-you'
  if (!login && !token) return null
  const title = login ? 'Claude needs you to sign in again' : "Claude's background token needs renewing"
  const what = [...h.login.failed, ...h.token.failed].map((f) => f.what)
  const body = what.length ? `Stopped: ${what.slice(-3).join('; ')}` : login ? 'Chats, workers and monitors can’t reach Claude until you do.' : 'Monitors can’t reach Claude until you do.'
  return { title, body }
}

const YEAR_MS = 365 * 24 * 3600_000

/** When a token made on `madeOn` (YYYY-MM-DD) runs out: a year later, as `setup-token` says. */
export function tokenEndsOn(madeOn: string): string {
  return new Date(Date.parse(`${madeOn}T00:00:00Z`) + YEAR_MS).toISOString().slice(0, 10)
}

/** Days left on a token (negative once it has run out); null without a made-on date. */
export function tokenDaysLeft(madeOn: string | null, now: number): number | null {
  if (!madeOn || Number.isNaN(Date.parse(`${madeOn}T00:00:00Z`))) return null
  return Math.floor((Date.parse(`${tokenEndsOn(madeOn)}T00:00:00Z`) - now) / (24 * 3600_000))
}

// ---------- the token file (a systemd EnvironmentFile) ----------

export const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN'
const TOKEN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/

export function tokenFileText(token: string, madeOn: string): string {
  return `# Claude long-lived token for background runs (claude setup-token), made ${madeOn}. Keep this file private.\n${TOKEN_ENV}=${token}\n`
}

/** The token and the day it was made, from the file's text; null when there's no token in it. */
export function readTokenFile(text: string): { token: string; madeOn: string | null } | null {
  const line = text.split('\n').find((l) => l.trim().startsWith(`${TOKEN_ENV}=`))
  const token = line?.trim().slice(TOKEN_ENV.length + 1).replace(/^["']|["']$/g, '').trim()
  if (!token) return null
  const made = /made (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null
  return { token, madeOn: made }
}

/** The token `claude setup-token` prints once at the end ("Your OAuth token (valid for 1 year): sk-ant-oat01-…"). */
export function setupTokenFrom(output: string): string | null {
  return TOKEN.exec(plainText(output))?.[0] ?? null
}
