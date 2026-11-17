// Web Push over the web-push package: VAPID-signed, encrypted messages to the
// browser's push service (Google's for Chrome, Apple's for iPhone and Mac Safari). No Firebase, no account.
// Subscribers and the VAPID keys live in files private to the user the hub runs as.

import { promises as fs, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import webpush from 'web-push'
import type { PushPayload, PushSubscriptionJson, Subscriber } from '../domain/push.ts'

async function writePrivate(path: string, data: string) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await fs.writeFile(tmp, data, { mode: 0o600 })
  await fs.rename(tmp, path)
}

/** The VAPID key pair, made once on first start. */
export async function vapidKeys(path: string): Promise<{ publicKey: string; privateKey: string }> {
  try {
    const k = JSON.parse(await fs.readFile(path, 'utf8'))
    if (k.publicKey && k.privateKey) return k
  } catch {}
  const k = webpush.generateVAPIDKeys()
  await writePrivate(path, JSON.stringify(k))
  return k
}

export class SubscriberFile {
  private path: string
  private list: Subscriber[] = []
  constructor(path: string) {
    this.path = path
    try {
      this.list = JSON.parse(readFileSync(path, 'utf8'))
    } catch {}
  }
  all(): Subscriber[] {
    return this.list
  }
  find(endpoint: string): Subscriber | undefined {
    return this.list.find((s) => s.subscription.endpoint === endpoint)
  }
  async put(s: Subscriber) {
    this.list = [...this.list.filter((x) => x.subscription.endpoint !== s.subscription.endpoint), s]
    await writePrivate(this.path, JSON.stringify(this.list, null, 1))
  }
  async remove(endpoint: string) {
    this.list = this.list.filter((x) => x.subscription.endpoint !== endpoint)
    await writePrivate(this.path, JSON.stringify(this.list, null, 1))
  }
}

export interface PushSender {
  send(sub: PushSubscriptionJson, payload: PushPayload): Promise<'sent' | 'gone'>
}

export function webPushSender(o: { subject: string; keys: { publicKey: string; privateKey: string } }): PushSender {
  return {
    async send(subscription, payload) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          vapidDetails: { subject: o.subject, publicKey: o.keys.publicKey, privateKey: o.keys.privateKey },
          TTL: 6 * 60 * 60,
          urgency: payload.kind === 'done' ? 'normal' : 'high',
        })
        return 'sent'
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) return 'gone'
        throw new Error(`Push service said ${e?.statusCode ?? e?.message}`)
      }
    },
  }
}
