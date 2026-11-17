// Limeade's service worker. Nothing is cached: every request goes to the network, so Cloudflare Access
// always sees it. It's here for Install and for Web Push notifications.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

/** Asks one window whether this chat (the Assistant by default) is in front of the user right now (it knows; we don't). */
function ask(client, chatId) {
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    const timer = setTimeout(() => resolve(false), 500)
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data === true) }
    client.postMessage({ type: 'looking-at-chat?', chatId: chatId || 'assistant' }, [ch.port2])
  })
}

/** A visible Limeade window that says it's showing the chat, or null. A second guard: the hub already skips
 * pushes to a device showing the chat. Not `focused`: installed apps on Android often report false. */
async function chatInFront(chatId) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const c of wins) {
    if (c.visibilityState === 'visible' && (await ask(c, chatId))) return c
  }
  return null
}

self.addEventListener('push', (e) => {
  let m = {}
  try { m = e.data?.json() ?? {} } catch { m = { body: e.data?.text() } }
  const approval = m.kind === 'approval' && m.approvalId
  e.waitUntil(show(m, approval))
})

async function show(m, approval) {
  // He's looking at the chat: it shows there already, so no phone notification. Closed, hidden, or on
  // another page: notify as usual.
  const win = await chatInFront(m.chatId)
  if (win) {
    win.postMessage({ type: 'push-inline', push: m })
    return
  }
  const entry = {
    key: m.tag || `push-${Date.now()}`,
    title: m.title || 'Limeade',
    body: m.body || '',
    url: m.url || '/',
    approvalId: approval ? m.approvalId : null,
  }
  return inTurn(async () => present(addEntry(await currentEntries(), entry), true))
}

// ---------- one notification on the phone ----------
// Several notifications from one site make Android group them, and Chrome then draws its own square in
// the status bar instead of the lime badge. So there is only ever one, tagged ONE_TAG, updated in place:
// it lists every unseen item in its data, shows the newest (an approval wins, for its buttons) and the count.

const ONE_TAG = 'limeade'
const MAX_ENTRIES = 30

/** Runs read-then-replace steps one at a time, so two pushes landing together both count. */
let turn = Promise.resolve()
function inTurn(step) {
  const run = turn.then(step, step)
  turn = run.catch(() => {})
  return run
}

/** The list with `entry` as the newest; the same item sent again replaces its old place. */
function addEntry(entries, entry) {
  return [...entries.filter((x) => x.key !== entry.key), entry].slice(-MAX_ENTRIES)
}

/** What the one notification says for these entries (null: nothing left, close it). */
function noticeFor(entries) {
  if (!entries.length) return null
  const shown = [...entries].reverse().find((x) => x.approvalId) || entries[entries.length - 1]
  const n = entries.length
  return {
    title: n > 1 ? `${n} new · ${shown.title}` : shown.title,
    body: shown.body,
    approvalId: shown.approvalId || null,
    // One item: open it. Several: open the bell, which lists them all.
    url: n > 1 ? '/?bell=1' : shown.url,
  }
}

async function currentEntries() {
  const list = await self.registration.getNotifications({ tag: ONE_TAG })
  return list.flatMap((n) => n.data?.entries || [])
}

/** Shows (or replaces) the one notification. `buzz`: a new item arrived; false: a quiet update after a clear. */
async function present(entries, buzz) {
  const v = noticeFor(entries)
  // Notifications from before there was only one (per-item tags) go too, so they can't make a group.
  for (const n of await self.registration.getNotifications()) if (n.tag !== ONE_TAG || !v) n.close()
  if (!v) return
  return self.registration.showNotification(v.title, {
    body: v.body,
    icon: '/icons/192.png',
    badge: '/icons/lime-64.png',
    tag: ONE_TAG,
    renotify: buzz,
    silent: !buzz,
    requireInteraction: !!v.approvalId,
    data: { url: v.url, approvalId: v.approvalId, entries },
    // Shown where the platform supports buttons (Android, Chrome on a computer); elsewhere a tap opens Limeade.
    actions: v.approvalId
      ? [{ action: 'yes', title: 'Yes' }, { action: 'always', title: 'Always' }, { action: 'no', title: 'No' }]
      : [{ action: 'open', title: 'Open' }],
  })
}

/** Whether an entry is a bell item (inbox-<id>, approval-<id>) rather than a plain reply or update. */
function isBellEntry(x) {
  return /^(inbox|approval)-/.test(x.key)
}

/** What's left after a clear: 'all', 'replies' (everything but bell items), or a list of push tags. */
function entriesAfter(entries, keys) {
  if (keys === 'all') return []
  if (keys === 'replies') return entries.filter(isBellEntry)
  return entries.filter((x) => !keys.includes(x.key))
}

/** Takes items off the notification, quietly; closes it when none are left. */
function clearEntries(keys) {
  return inTurn(async () => {
    const before = await currentEntries()
    const after = entriesAfter(before, keys)
    if (after.length === before.length && after.length) return
    return present(after, false)
  })
}

// The page says which bell items left (opened, answered, dismissed), that he's seen the replies, or that
// the bell is empty.
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'clear-notice') return
  e.waitUntil(clearEntries(e.data.all ? 'all' : e.data.replies ? 'replies' : e.data.keys || []))
})

async function openApp(url) {
  const target = new URL(url || '/', self.location.origin)
  const itemId = target.searchParams.get('item')
  const bell = target.searchParams.has('bell')
  const chatId = target.searchParams.get('chat')
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const win = open.find((c) => new URL(c.url).origin === self.location.origin)
  if (win) {
    // Limeade is already open: bring it forward and tell it which bell item to open.
    try {
      await win.focus()
      if (itemId) win.postMessage({ type: 'open-item', itemId })
      else if (bell) win.postMessage({ type: 'open-bell' })
      else if (chatId) win.postMessage({ type: 'open-chat', chatId })
      return
    } catch { /* fall through */ }
  }
  return self.clients.openWindow(target.href)
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const { url, approvalId, entries = [] } = e.notification.data || {}
  const decision = ['yes', 'always', 'no'].includes(e.action) ? e.action : null
  e.waitUntil((async () => {
    if (decision && approvalId) {
      // Answer right from the notification. If the sign-in ran out (or it was already answered), open the app.
      const r = await fetch(`/approvals/${approvalId}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      }).catch(() => null)
      // Answered: the rest (if any) stays on the phone, quietly.
      // Tapping closed the notification; put back what's left, plus anything that came in meanwhile.
      if (r && r.ok) {
        const rest = entries.filter((x) => x.approvalId !== approvalId)
        return inTurn(async () => present((await currentEntries()).reduce(addEntry, rest), false))
      }
    }
    return openApp(url)
  })())
})
