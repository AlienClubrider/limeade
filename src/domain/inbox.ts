// The bell: things waiting on the user, all from the assistant. Pure rules.
//
// How an item is born:
//  - approval: every Claude Code permission prompt in an Assistant turn (automatic).
//  - question: an Assistant reply whose last paragraph ends with "?" (it asked him something).
//  - look:     an Assistant reply that starts with the marker "[needs you]" (no question, but he should
//              look: a preview to check, a decision to read). The marker is stripped from the text.
//  - sign-in:  Claude's sign-in stopped working (the hub's own check, not the Assistant's). At most one.
// How it goes away:
//  - approvals: when answered (here or in a notification) or when their turn ends.
//  - questions/looks: as soon as the user sends the Assistant anything after it, or when they dismiss it.
//  - sign-in: when the sign-in works again.

export type InboxKind = 'approval' | 'question' | 'look' | 'sign-in'

export interface InboxItem {
  id: string
  kind: InboxKind
  /** One line for the list and the notification title. */
  title: string
  /** A little more: the command to approve, or the question itself. */
  body: string
  at: string
  /** The Assistant message it came from (questions and looks). */
  messageId?: string
  approvalId?: string
}

const NEEDS = /^\s*\[needs you\]\s*/i

/** Strips the "[needs you]" marker; says whether the reply needs the user and how. */
export function readNeeds(raw: string): { text: string; needs: 'question' | 'look' | null } {
  const marked = NEEDS.test(raw)
  const text = raw.replace(NEEDS, '').trim()
  if (endsWithQuestion(text)) return { text, needs: 'question' }
  return { text, needs: marked ? 'look' : null }
}

/** The last paragraph (ignoring code blocks and trailing links) ends with a question mark. */
export function endsWithQuestion(text: string): boolean {
  const paras = text.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const last = (paras.at(-1) ?? '').replace(/[*_`)\]]+$/, '').trim()
  return last.endsWith('?')
}

/** The question itself: the last sentence ending in "?", in plain words, cut to fit. */
export function questionLine(text: string, max = 160): string {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  const m = /([^.!?]*\?)\s*$/.exec(plain)
  const q = (m?.[1] ?? plain).trim()
  return q.length > max ? `${q.slice(0, max - 1).trimEnd()}…` : q
}

/** The prompt that makes the assistant ask an old item again, at the bottom, with context. */
export function reaskPrompt(item: InboxItem): string {
  return [
    `[from the app] The user opened a pending item from ${item.at}: "${item.body || item.title}".`,
    'Ask it again now, briefly, with the context he needs to answer (he may not remember it). End with the question.',
  ].join(' ')
}
