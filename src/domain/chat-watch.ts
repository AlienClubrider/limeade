// Which devices have a chat (the Assistant or one on the Chat page) in front of the user right now. The page says so every ~20 s while
// it is on screen; a word older than WATCH_FRESH_MS no longer counts (the phone may have killed the page).
// Pure: the clock is passed in.

import { ASSISTANT_ID } from './chat.ts'

export const WATCH_FRESH_MS = 45_000

export class ChatWatchers {
  private lastSeen = new Map<string, { at: number; chatId: string }>()

  /** The device with this push endpoint says whether it is showing that chat, at `now`. */
  report(endpoint: string, watching: boolean, now: number, chatId: string = ASSISTANT_ID) {
    if (watching) this.lastSeen.set(endpoint, { at: now, chatId })
    else this.lastSeen.delete(endpoint)
  }

  /** Is that device showing this chat? A notice about it is on his screen already (the thread or its bell). */
  isWatching(endpoint: string, now: number, chatId: string = ASSISTANT_ID): boolean {
    const seen = this.lastSeen.get(endpoint)
    if (!seen) return false
    if (now - seen.at > WATCH_FRESH_MS) {
      this.lastSeen.delete(endpoint)
      return false
    }
    return seen.chatId === chatId
  }

  /** Is any of his devices showing this chat? Then a notice about it is in front of him: no device buzzes. */
  anyWatching(chatId: string, now: number): boolean {
    return [...this.lastSeen.keys()].some((endpoint) => this.isWatching(endpoint, now, chatId))
  }
}
