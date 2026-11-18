import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createAccessCheck } from '../src/domain/access.ts'
import { kindsFrom, payloadFor, pushKindOf, wants, isSubscription } from '../src/domain/push.ts'
import { PushOut } from '../src/app/push.ts'
import { ChatWatchers, WATCH_FRESH_MS } from '../src/domain/chat-watch.ts'

const TEAM = 'example-team.cloudflareaccess.com'
const AUD = 'aud-tag'
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' }

function token(payload: object, kid = 'k1') {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = enc({ alg: 'RS256', kid })
  const body = enc(payload)
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}

test('Access tokens: only a valid, unexpired token for an allowed email passes', async () => {
  const now = 1_800_000_000_000
  const check = createAccessCheck({ team: TEAM, aud: AUD, emails: ['Owner@Example.com'], fetchCerts: async () => ({ keys: [jwk] }), now: () => now })
  const good = { iss: `https://${TEAM}`, aud: [AUD], exp: now / 1000 + 60, email: 'owner@example.com' }
  assert.equal(await check.emailFor({ 'cf-access-jwt-assertion': token(good) }), 'owner@example.com')
  assert.equal(await check.emailFor({ cookie: `a=b; CF_Authorization=${token(good)}` }), 'owner@example.com')
  assert.equal(await check.emailFor({ 'cf-access-jwt-assertion': token({ ...good, email: 'someone@else.com' }) }), null)
  assert.equal(await check.emailFor({ 'cf-access-jwt-assertion': token({ ...good, aud: ['other'] }) }), null)
  assert.equal(await check.emailFor({ 'cf-access-jwt-assertion': token({ ...good, exp: now / 1000 - 1 }) }), null)
  assert.equal(await check.emailFor({ 'cf-access-jwt-assertion': token({ ...good, iss: 'https://evil.example' }) }), null)
  const forged = token(good).split('.')
  assert.equal(await check.emailFor({ 'cf-access-jwt-assertion': `${forged[0]}.${Buffer.from(JSON.stringify({ ...good, email: 'x' })).toString('base64url')}.${forged[2]}` }), null)
  assert.equal(await check.emailFor({}), null)
})

test('push rules: toggles per kind; replies count as done; approvals carry their id', () => {
  const s = { subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }, kinds: kindsFrom({ needs: false }), label: '', at: '' }
  assert.equal(pushKindOf({ kind: 'reply' }), 'done')
  assert.equal(wants(s, { kind: 'needs' }), false)
  assert.equal(wants(s, { kind: 'approval' }), true)
  const p = payloadFor({ seq: 3, at: '', kind: 'approval', title: 'Assistant wants to run', body: 'npm test', chatId: 'assistant', approvalId: 'a1' })
  assert.deepEqual([p.tag, p.approvalId, p.kind], ['approval-a1', 'a1', 'approval'])
  // A chat on the Chat page: its notification opens that chat.
  const c = payloadFor({ seq: 4, at: '', kind: 'reply', title: 'Plan', body: 'b', chatId: 'c-1' })
  assert.deepEqual([c.url, c.chatId], ['/?chat=c-1', 'c-1'])
  assert.equal(c.test, undefined)
  assert.equal(payloadFor({ seq: 5, at: '', kind: 'done', title: 'Limeade', body: 'Test', chatId: 'assistant', test: true }).test, true)
  assert.equal(isSubscription({ endpoint: 'http://insecure', keys: { p256dh: 'p', auth: 'a' } }), false)
  assert.equal(isSubscription(s.subscription), true)
})

test('push out: sends to those who want it, forgets gone browsers, never throws', async () => {
  const subs = [
    { subscription: { endpoint: 'https://p/1', keys: { p256dh: 'p', auth: 'a' } }, kinds: kindsFrom({}), label: '', at: '' },
    { subscription: { endpoint: 'https://p/2', keys: { p256dh: 'p', auth: 'a' } }, kinds: kindsFrom({ done: false }), label: '', at: '' },
    { subscription: { endpoint: 'https://p/3', keys: { p256dh: 'p', auth: 'a' } }, kinds: kindsFrom({}), label: '', at: '' },
  ]
  const removed: string[] = []
  const sent: string[] = []
  const out = new PushOut(
    { all: () => subs, remove: async (e) => { removed.push(e) } },
    { send: async (s) => { if (s.endpoint.endsWith('3')) return 'gone'; if (s.endpoint.endsWith('2')) throw new Error('boom'); sent.push(s.endpoint); return 'sent' } },
    () => {},
  )
  const n = { seq: 1, at: '', kind: 'done' as const, title: 't', body: 'b', chatId: 'assistant' }
  assert.equal(await out.notice(n), 1)
  assert.deepEqual(sent, ['https://p/1'])
  assert.deepEqual(removed, ['https://p/3'])
  assert.equal(await out.notice({ ...n, kind: 'needs' }, 'https://p/1'), 1) // test push to one device
})

test('chat watchers: a device counts as showing the chat only while its word is fresh', () => {
  const w = new ChatWatchers()
  assert.equal(w.isWatching('https://p/1', 0), false)
  w.report('https://p/1', true, 1000)
  assert.equal(w.isWatching('https://p/1', 1000 + WATCH_FRESH_MS), true)
  assert.equal(w.isWatching('https://p/1', 1001 + WATCH_FRESH_MS), false) // stale: the page went quiet
  w.report('https://p/1', true, 5000)
  w.report('https://p/1', false, 6000) // hidden, or another page
  assert.equal(w.isWatching('https://p/1', 6000), false)
  assert.equal(w.isWatching('https://p/2', 6000), false)
  w.report('https://p/1', true, 7000, 'c-1') // a chat on the Chat page
  assert.equal(w.isWatching('https://p/1', 7000, 'c-1'), true)
  assert.equal(w.isWatching('https://p/1', 7000), false) // not the Assistant
})

test('chat watchers: a chat is watched if any device shows it, until that word goes stale', () => {
  const w = new ChatWatchers()
  assert.equal(w.anyWatching('assistant', 0), false)
  w.report('https://p/1', true, 1000, 'c-1')
  w.report('https://p/2', true, 2000)
  assert.equal(w.anyWatching('c-1', 2000), true)
  assert.equal(w.anyWatching('assistant', 2000), true)
  assert.equal(w.anyWatching('c-2', 2000), false)
  assert.equal(w.anyWatching('c-1', 1001 + WATCH_FRESH_MS), false) // that device went quiet
  assert.equal(w.anyWatching('assistant', 1001 + WATCH_FRESH_MS), true)
})

test('push out: no buzz on any device while one shows the chat; other chats, stale watchers and test pushes still go', async () => {
  const sub = (n: number) => ({ subscription: { endpoint: `https://p/${n}`, keys: { p256dh: 'p', auth: 'a' } }, kinds: kindsFrom({}), label: '', at: '' })
  const w = new ChatWatchers()
  let clock = 0
  const sent: string[] = []
  const out = new PushOut(
    { all: () => [sub(1), sub(2)], remove: async () => {} },
    { send: async (s) => { sent.push(s.endpoint); return 'sent' } },
    () => {},
    (chat) => w.anyWatching(chat, clock),
  )
  w.report('https://p/1', true, 0) // the Mac shows the Assistant
  const base = { seq: 1, at: '', title: 't', body: 'b', chatId: 'assistant' }
  for (const kind of ['reply', 'needs', 'approval'] as const) {
    sent.length = 0
    await out.notice({ ...base, kind, ...(kind === 'approval' ? { approvalId: 'a1' } : {}) })
    assert.deepEqual(sent, [], kind) // the phone stays quiet too: it's in front of him on the Mac
  }
  sent.length = 0
  await out.notice({ ...base, kind: 'needs', chatId: 'c-other' })
  assert.deepEqual(sent, ['https://p/1', 'https://p/2']) // another chat's notice isn't on his screen
  sent.length = 0
  await out.notice({ ...base, kind: 'done' }, 'https://p/1')
  assert.deepEqual(sent, ['https://p/1']) // Settings' test push always goes
  clock = WATCH_FRESH_MS + 1 // the Mac went to sleep without a word
  sent.length = 0
  await out.notice({ ...base, kind: 'reply' })
  assert.deepEqual(sent, ['https://p/1', 'https://p/2'])
  w.report('https://p/2', true, clock, 'c-1') // the phone shows a Chat thread
  sent.length = 0
  await out.notice({ ...base, kind: 'reply', chatId: 'c-1' })
  assert.deepEqual(sent, [])
  w.report('https://p/2', false, clock) // hidden
  sent.length = 0
  await out.notice({ ...base, kind: 'reply', chatId: 'c-1' })
  assert.deepEqual(sent, ['https://p/1', 'https://p/2'])
})

test('Settings scrolls with no visible scrollbar on every screen, not only on phones', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8')
  // top-level rules only: a rule inside @media (hover: none) would leave the desktop bar showing
  let top = '', depth = 0
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') depth++
    if (depth <= 1 && !(ch === '}' && depth === 0)) top += ch
    if (ch === '}') depth--
  }
  // what's left: top-level rules whole, and each @media reduced to its head and loose '}'s
  const rule = (sel: string) => new RegExp(`(^|[\\n}])\\s*${sel.replace(/[.:-]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(top)?.[2] ?? ''
  assert.match(rule('.settings-page .pagebody'), /scrollbar-width:\s*none/)
  assert.match(rule('.settings-page .pagebody::-webkit-scrollbar'), /display:\s*none/)
  assert.doesNotMatch(rule('.settings-page .pagebody'), /overflow(-y)?:\s*hidden/) // still scrolls
})
