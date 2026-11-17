// Sends each notice to every subscribed browser that wants that kind; forgets browsers that unsubscribed.

import { payloadFor, wants, type Subscriber } from '../domain/push.ts'
import type { Notice } from '../ports.ts'
import type { PushSender } from '../adapters/web-push.ts'

export interface SubscriberStore {
  all(): Subscriber[]
  remove(endpoint: string): Promise<void>
}

export class PushOut {
  private store: SubscriberStore
  private sender: PushSender
  private log: (l: string) => void
  private watching: (chatId: string) => boolean
  /** `watching`: is any of his devices showing this notice's chat right now? Then no device gets it (no buzz). */
  constructor(store: SubscriberStore, sender: PushSender, log: (l: string) => void = console.log, watching: (chatId: string) => boolean = () => false) {
    this.store = store
    this.sender = sender
    this.log = log
    this.watching = watching
  }

  /** Returns how many it reached. Never throws: a failed push must not break a turn. */
  async notice(n: Notice, only?: string): Promise<number> {
    let sent = 0
    if (!only && this.watching(n.chatId)) return 0
    for (const s of this.store.all()) {
      if (only ? s.subscription.endpoint !== only : !wants(s, n)) continue
      try {
        if ((await this.sender.send(s.subscription, payloadFor(n))) === 'gone') await this.store.remove(s.subscription.endpoint)
        else sent++
      } catch (e) {
        this.log(`push failed: ${(e as Error).message}`)
      }
    }
    if (sent) this.log(`push: ${n.kind} sent to ${sent} device${sent === 1 ? '' : 's'}`)
    return sent
  }
}
