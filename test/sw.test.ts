// The service worker keeps one Limeade notification on the phone (so Android never groups them and the
// lime badge shows). Runs public/sw.js against a fake registration.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

interface Shown { title: string; tag: string; body: string; renotify: boolean; data: any; actions: { action: string }[]; close(): void }

/** A real MessageChannel's open port keeps node running after the tests; this one just hands the reply over. */
class FakeChannel {
  port1: { onmessage?: (e: { data: unknown }) => void } = {}
  port2 = { postMessage: (data: unknown) => queueMicrotask(() => this.port1.onmessage?.({ data })) }
}

function worker(opts: { fetchOk?: boolean; window?: any } = {}) {
  let shown: Shown[] = []
  const listeners: Record<string, (e: any) => void> = {}
  const opened: string[] = []
  const registration = {
    async getNotifications(f?: { tag?: string }) { return shown.filter((n) => !f?.tag || n.tag === f.tag) },
    async showNotification(title: string, o: any) {
      shown = shown.filter((n) => n.tag !== o.tag)
      const n: Shown = { title, ...o, close: () => { shown = shown.filter((x) => x !== n) } }
      shown.push(n)
    },
  }
  const self = {
    registration,
    location: { origin: 'https://lime.test' },
    clients: { matchAll: async () => (opts.window ? [opts.window] : []), claim: async () => {}, openWindow: async (u: string) => { opened.push(u) } },
    addEventListener: (t: string, fn: (e: any) => void) => { listeners[t] = fn },
    skipWaiting() {},
  }
  const fetch = async () => ({ ok: opts.fetchOk !== false })
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, fetch, URL, MessageChannel: FakeChannel, setTimeout, clearTimeout, console })
  async function fire(type: string, e: any) {
    let done: Promise<unknown> = Promise.resolve()
    listeners[type]!({ ...e, waitUntil: (p: Promise<unknown>) => { done = p } })
    await done
  }
  return {
    get shown() { return shown },
    opened,
    legacy(tag: string) { shown.push({ title: 'old', tag, body: '', renotify: true, data: {}, actions: [], close() { shown = shown.filter((x) => x !== this) } }) },
    push: (m: object) => fire('push', { data: { json: () => m } }),
    message: (data: object) => fire('message', { data }),
    click: (action = '') => fire('notificationclick', { action, notification: shown[0] }),
  }
}

const reply = (n: number) => ({ title: 'Assistant', body: `reply ${n}`, tag: `notice-${n}`, url: '/', kind: 'done' })
const approval = (id: string) => ({ title: 'Wants to run', body: `cmd ${id}`, tag: `approval-${id}`, url: `/?item=i-${id}`, kind: 'approval', approvalId: id })

test('one notification: every push updates it in place, with the newest text and a count', async () => {
  const w = worker()
  await w.push(reply(1))
  assert.equal(w.shown.length, 1)
  assert.equal(w.shown[0]!.title, 'Assistant')
  assert.equal(w.shown[0]!.data.url, '/')
  await w.push(reply(2))
  await w.push({ title: 'The assistant asks', body: 'Ship it?', tag: 'inbox-q1', url: '/?item=q1', kind: 'needs' })
  assert.equal(w.shown.length, 1)
  const n = w.shown[0]!
  assert.deepEqual([n.tag, n.title, n.body, n.renotify], ['limeade', '3 new · The assistant asks', 'Ship it?', true])
  assert.equal(n.data.url, '/?bell=1', 'several items: a tap opens the bell')
})

test('pushes landing together all count', async () => {
  const w = worker()
  await Promise.all([w.push(reply(1)), w.push(reply(2)), w.push(reply(3))])
  assert.equal(w.shown.length, 1)
  assert.equal(w.shown[0]!.title, '3 new · Assistant')
})

test('an approval wins: its buttons show even when a reply is newer', async () => {
  const w = worker()
  await w.push(approval('a1'))
  await w.push(reply(2))
  const n = w.shown[0]!
  assert.equal(n.title, '2 new · Wants to run')
  assert.equal(n.data.approvalId, 'a1')
  assert.deepEqual([...n.actions.map((a) => a.action)], ['yes', 'always', 'no'])
})

test('answering from the notification leaves the rest, quietly; a failed answer opens the app', async () => {
  const w = worker()
  await w.push(reply(1))
  await w.push(approval('a1'))
  await w.click('yes')
  assert.equal(w.shown.length, 1)
  assert.deepEqual([w.shown[0]!.title, w.shown[0]!.renotify, w.shown[0]!.data.approvalId], ['Assistant', false, null])

  const bad = worker({ fetchOk: false })
  await bad.push(approval('a2'))
  await bad.click('no')
  assert.deepEqual(bad.opened, ['https://lime.test/?item=i-a2'])
})

test('clearing: opened items leave it, seen replies leave it, an empty bell closes it', async () => {
  const w = worker()
  await w.push(reply(1))
  await w.push(approval('a1'))
  await w.push({ title: 'Please look', body: 'x', tag: 'inbox-q1', url: '/?item=q1', kind: 'needs' })
  await w.message({ type: 'clear-notice', keys: ['inbox-q1'] })
  assert.deepEqual([w.shown[0]!.title, w.shown[0]!.renotify], ['2 new · Wants to run', false])
  await w.message({ type: 'clear-notice', replies: true })
  assert.equal(w.shown[0]!.title, 'Wants to run')
  await w.message({ type: 'clear-notice', all: true })
  assert.equal(w.shown.length, 0)
})

test('notifications from before (one per item) are closed so they cannot make a group', async () => {
  const w = worker()
  w.legacy('inbox-old')
  w.legacy('notice-7')
  await w.push(reply(1))
  assert.deepEqual([...w.shown.map((n) => n.tag)], ['limeade'])
})

/** A visible Limeade window whose page answers "is this chat in front of him?" with `showing`. */
function windowShowing(showing: boolean) {
  const posted: any[] = []
  return {
    posted,
    visibilityState: 'visible',
    postMessage(m: any, ports?: { postMessage(d: unknown): void }[]) {
      posted.push(m)
      if (m.type === 'looking-at-chat?') ports?.[0]?.postMessage(showing)
    },
  }
}

test('a push for the chat he is looking at goes into the page, not a notification', async () => {
  const win = windowShowing(true)
  const w = worker({ window: win })
  await w.push(reply(1))
  assert.equal(w.shown.length, 0)
  assert.equal(win.posted.at(-1).type, 'push-inline')
})

test('Send a test always shows a notification, even with the chat on screen', async () => {
  const win = windowShowing(true)
  const w = worker({ window: win })
  await w.push({ ...reply(1), body: 'Test notification', test: true })
  assert.equal(w.shown.length, 1)
  assert.equal(w.shown[0]!.body, 'Test notification')
  assert.equal(win.posted.length, 0, 'the page is not even asked')
})
