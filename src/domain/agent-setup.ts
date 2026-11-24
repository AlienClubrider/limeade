// Setting up an agent (Settings › Agents): which package Limeade installs for it, what its own CLI says
// about its version and sign-in, and the sign-in link it prints. Pure rules; the CLIs are run elsewhere.

import type { Agent, AgentStatus } from './models.ts'

/** What Limeade installs for an agent: an npm package, pinned, into a folder the user owns. */
export interface AgentPackage {
  pkg: string
  version: string
  /** The command the package installs. */
  bin: string
}

/** Pinned: an update in Limeade is a new pin here. */
export const AGENT_PACKAGES: Readonly<Record<Agent, AgentPackage>> = {
  claude: { pkg: '@anthropic-ai/claude-code', version: '2.1.311', bin: 'claude' },
  codex: { pkg: '@openai/codex', version: '0.166.0', bin: 'codex' },
}

/** The environment variable an API key reaches each agent in (Limeade keeps the key, not the agent). */
export const API_KEY_ENV: Readonly<Record<Agent, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'CODEX_API_KEY',
}

/** The first x.y.z in a CLI's --version line ("2.1.311 (Claude Code)", "codex-cli 0.166.0"). */
export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null
}

/** Whether version `a` is older than `b` (x.y.z only). */
export function isOlder(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  }
  return false
}

export type SignInHow = 'subscription' | 'console' | 'api-key' | 'chatgpt'

export interface SignInState {
  signedIn: boolean
  how: SignInHow | null
  account: string | null
}

const NOT_SIGNED_IN: SignInState = { signedIn: false, how: null, account: null }

/** `claude auth status` (JSON): {loggedIn, authMethod: "claude.ai" | "console" | "api_key" | "none", email?}. */
export function claudeSignIn(stdout: string): SignInState {
  let s: any
  try {
    s = JSON.parse(stdout)
  } catch {
    return NOT_SIGNED_IN
  }
  if (s?.loggedIn !== true) return NOT_SIGNED_IN
  const how: SignInHow | null = s.authMethod === 'claude.ai' ? 'subscription' : s.authMethod === 'api_key' ? 'api-key' : s.authMethod === 'console' ? 'console' : null
  return { signedIn: true, how, account: typeof s.email === 'string' ? s.email : null }
}

/** `codex login status`: "Logged in using ChatGPT" / "Logged in using an API key - sk-…" / "Not logged in" (exit 1). */
export function codexSignIn(output: string, ok: boolean): SignInState {
  if (!ok || !/logged in using/i.test(output)) return NOT_SIGNED_IN
  return { signedIn: true, how: /api key/i.test(output) ? 'api-key' : 'chatgpt', account: null }
}

/** What the agent picker says under an agent that can't run its own models yet; null when it can. */
export function pickerNote(status: Pick<AgentStatus, 'installed' | 'signedIn'>): 'not installed' | 'not signed in' | null {
  if (!status.installed) return 'not installed'
  return status.signedIn ? null : 'not signed in'
}

/** Terminal colours and link wrappers out of a CLI's output. */
export function plainText(output: string): string {
  return output
    .replace(/\u001b\[\d*G/g, ' ') // a terminal app's "move to column": a gap between words
    .replace(/\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g, '') // OSC 8 hyperlink markers (with or without an id)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // other OSC (a terminal's title, its queries)
    .replace(/\u001b\[[0-9;?<>=!]*[A-Za-z~]/g, '')
    .replace(/\u001b[78=>]/g, '')
    .replace(/\r/g, '')
}

/** A sign-in the agent's CLI started: the page to open and, for a device sign-in, the code to type there. */
export interface SignInLink {
  url: string
  /** Codex: the one-time code to enter on the page. */
  userCode: string | null
  /** Claude: the page shows a code to paste back here. */
  wantsCode: boolean
}

/**
 * The link in `claude auth login` ("If the browser didn't open, visit: https://…") or
 * `codex login --device-auth` ("1. Open this link … https://auth.openai.com/codex/device · 2. Enter this
 * one-time code … ABCD-12345"). Null until the whole link has been printed.
 */
export function signInLink(agent: Agent, output: string): SignInLink | null {
  const text = plainText(output)
  if (agent === 'claude') {
    // `auth login`: "visit: https://…"; `setup-token` (a terminal app): "Use the URL below to sign in" and the link.
    const m = /visit:\s*(https:\/\/\S+)\s/.exec(text) ?? /URL below[^\n]*\n\s*(https:\/\/\S+)\s/.exec(text)
    return m ? { url: m[1]!, userCode: null, wantsCode: /paste code/i.test(text) } : null
  }
  const url = /(https:\/\/auth\.openai\.com\/\S+)/.exec(text)?.[1]
  const code = /one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/.exec(text)?.[1]
  return url && code ? { url, userCode: code, wantsCode: false } : null
}

/** Why a sign-in failed, in the CLI's words ("Login failed: That code wasn't accepted…"), or null. */
export function signInFailure(output: string): string | null {
  const text = plainText(output)
  const m = /(?:Login failed|Error)[:\s]+([^\n]+)/i.exec(text)
  return m ? m[1]!.trim().slice(0, 300) : null
}

/** An API key as pasted: trimmed, one line, a sane length. Null when it can't be a key. */
export function cleanKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  return /^[\x21-\x7e]{20,400}$/.test(key) ? key : null
}

/** A code pasted back from Claude's sign-in page ("<code>#<state>"). */
export function cleanCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim()
  return /^[\x21-\x7e]{8,2000}$/.test(code) ? code : null
}
