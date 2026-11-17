// Web Push: which phones and browsers get which notices, and what the notification says. Pure rules.

import type { Notice } from '../ports.ts'

/** The Settings toggles: "Work is done", "A worker needs me", "A command needs approval". */
export type PushKind = 'done' | 'needs' | 'approval'
export const PUSH_KINDS: readonly PushKind[] = ['done', 'needs', 'approval']

export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface Subscriber {
  subscription: PushSubscriptionJson
  kinds: Record<PushKind, boolean>
  /** e.g. "iPhone Safari", shown nowhere yet but handy in the file. */
  label: string
  at: string
}

/** Replies to the user's own messages count as "done". */
export function pushKindOf(n: Pick<Notice, 'kind'>): PushKind {
  return n.kind === 'reply' ? 'done' : n.kind
}

export function wants(s: Subscriber, n: Pick<Notice, 'kind'>): boolean {
  return s.kinds[pushKindOf(n)] !== false
}

export function isSubscription(v: unknown): v is PushSubscriptionJson {
  const s = v as PushSubscriptionJson
  return (
    !!s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 2000 &&
    typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string'
  )
}

export function kindsFrom(v: unknown): Record<PushKind, boolean> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { done: o.done !== false, needs: o.needs !== false, approval: o.approval !== false }
}

/** What the service worker shows. Approvals carry the id so Yes / Always / No can answer from the notification. */
export interface PushPayload {
  title: string
  body: string
  tag: string
  url: string
  kind: PushKind
  approvalId?: string
  chatId: string
  test?: boolean
}

export function payloadFor(n: Notice): PushPayload {
  return {
    title: n.title,
    body: n.body,
    // Names the item inside the phone's one Limeade notification (sw.js keeps one, so Android never groups them).
    tag: n.approvalId ? `approval-${n.approvalId}` : n.inboxId ? `inbox-${n.inboxId}` : `notice-${n.seq}`,
    // Opens Limeade on that bell item, that chat on the Chat page, or just the Assistant.
    url: n.inboxId ? `/?item=${encodeURIComponent(n.inboxId)}` : n.chatId && n.chatId !== 'assistant' ? `/?chat=${encodeURIComponent(n.chatId)}` : '/',
    chatId: n.chatId,
    kind: pushKindOf(n),
    ...(n.approvalId ? { approvalId: n.approvalId } : {}),
    ...(n.test ? { test: true } : {}),
  }
}
