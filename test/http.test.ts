import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Conversations } from '../src/app/conversations.ts'
import { createHub } from '../src/adapters/http.ts'
import type { Chat } from '../src/domain/chat.ts'
import type { Notice } from '../src/ports.ts'
import { MachineModels } from '../src/app/machine-models.ts'
import { RestartGate } from '../src/domain/restart-gate.ts'
import { HomeFolderTree } from '../src/adapters/home-folders.ts'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'k'.repeat(40)

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const stopped: string[] = []
const drafts: string[] = []

async function start(extra: Record<string, unknown> = {}) {
  const chats = new Map<string, Chat>()
  const notices: Notice[] = []
  const noticeLog = {
    since: (s: number) => notices.filter((n) => n.seq > s),
    append: async (n: Omit<Notice, 'seq' | 'at'>) => {
      const saved = { ...n, seq: notices.length + 1, at: 'now' }
      notices.push(saved)
      return saved
    },
  }
  let mode: 'claude-app' | 'app' = 'claude-app'
  const fleetMode = { get: async () => mode, set: async (m: typeof mode) => { mode = m } }
  const conversations = new Conversations({
    store: {
      list: () => [...chats.values()],
      get: (id) => chats.get(id) ?? null,
      save: async (c) => { chats.set(c.id, c) },
      remove: async (id) => { chats.delete(id) },
    },
    notices: noticeLog,
    engines: {
      claude: { run: async () => ({ text: '**TL;DR:** hi', sessionId: 's' }) },
      local: { run: async (r) => { r.onEvent({ type: 'text', text: 'echo' }); return { text: 'echo', sessionId: null } } },
    },
    fleet: { lines: async () => [], cursor: async () => 0, lastWake: async () => 0, setLastWake: async () => {} },
    fleetMode,
    claudeVersions: { get: () => ({ opus: 'claude-opus-5-5' }), set: async () => {} },
    defaultChatModel: 'local:m',
  })
  // A stand-in Toolbox that checks the cookie the hub adds.
  const toolbox = createServer((req, res) => {
    const ok = req.headers.cookie === `tb=${encodeURIComponent('tool-key')}`
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(ok ? { path: req.url } : { error: 'pair' }))
  })
  const toolboxUrl = await listen(toolbox)
  const hub = createHub({
    key: KEY,
    conversations,
    notices: noticeLog,
    fleetMode,
    localModels: { groups: async () => [{ title: 'GPU box', engine: 'local', online: true, models: [] }] },
    claudeVersions: { get: () => ({ opus: 'claude-opus-5-5' }), set: async () => {} },
    toolbox: { url: toolboxUrl, key: 'tool-key' },
    oneShot: {
      claude: { complete: async (r) => { drafts.push(`claude:${r.model}:${r.effort}`); return '```json\n{"id":"catch-up","summary":"Moved it up.","content":"---\\nname: catch-up\\n---\\nnew"}\n```' } },
      local: { complete: async (r) => { drafts.push(`local:${r.model}`); return 'not json' } },
    },
    workers: {
      list: async () => [{ id: 'cc-x', title: 'X', state: 'needs', now: 'Which theme?', at: 't' }],
      get: async (id) => (id === 'cc-x' ? { id, title: 'X', state: 'needs', now: 'Which theme?', at: 't', job: 'Dark theme', lines: [], startedAt: null, machine: 'Homelab', model: 'Opus 5.5', agent: 'developer', dir: '/d' } : null),
      stop: async (id) => { stopped.push(id) },
    },
    version: 'test',
    log: () => {},
    ...extra,
  })
  const base = await listen(hub)
  const call = (path: string, init: RequestInit = {}, key = KEY) =>
    fetch(base + path, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers } })
  return { base, call, close: () => { hub.close(); toolbox.close(); hub.closeAllConnections(); toolbox.closeAllConnections() } }
}

test('key is required and wrong keys are banned after five tries', async () => {
  const h = await start()
  try {
    assert.equal((await fetch(`${h.base}/health`)).status, 200) // local health check is open
    for (let i = 0; i < 5; i++) assert.equal((await h.call('/status', {}, 'wrong')).status, 401)
    assert.equal((await h.call('/status', {}, 'wrong')).status, 429)
    assert.equal((await h.call('/status')).status, 200) // the right key still gets in
  } finally {
    h.close()
  }
})

test('models, chats, messages and fleet mode', async () => {
  const h = await start()
  try {
    const models = await (await h.call('/models')).json()
    assert.deepEqual(models.groups.map((g: any) => g.title), ['Claude · your subscription', 'GPU box'])
    assert.equal(models.groups[0].models[0].label, 'Opus 5.5')

    const chat = await (await h.call('/chats', { method: 'POST', body: '{}' })).json()
    assert.equal(chat.model, 'local:m')
    assert.equal((await h.call(`/chats/${chat.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) })).status, 202)
    await new Promise((r) => setTimeout(r, 20))
    const got = await (await h.call(`/chats/${chat.id}`)).json()
    assert.deepEqual(got.messages.map((m: any) => m.text), ['hi', 'echo'])
    const list = await (await h.call('/chats')).json()
    assert.equal(list.chats[0].title, 'hi')

    assert.equal((await h.call('/fleet-mode', { method: 'PUT', body: JSON.stringify({ mode: 'lemonade' }) })).status, 400)
    assert.equal((await (await h.call('/fleet-mode', { method: 'PUT', body: JSON.stringify({ mode: 'app' }) })).json()).mode, 'app')

    const notices = await (await h.call('/notices?since=0')).json()
    assert.equal(notices.notices[0].kind, 'reply')
    assert.equal((await h.call('/chats/nope')).status, 404)
    assert.equal((await h.call(`/chats/${chat.id}`, { method: 'DELETE' })).status, 200)
  } finally {
    h.close()
  }
})

test('stream replays missed notices', async () => {
  const h = await start()
  try {
    const chat = await (await h.call('/chats', { method: 'POST', body: '{}' })).json()
    await h.call(`/chats/${chat.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) })
    await new Promise((r) => setTimeout(r, 20))
    const ctl = new AbortController()
    const r = await h.call('/stream?since=0', { signal: ctl.signal })
    const reader = r.body!.getReader()
    let text = ''
    while (!text.includes('event: hello')) text += new TextDecoder().decode((await reader.read()).value)
    ctl.abort()
    assert.match(text, /event: notice\ndata: .*"kind":"reply"/)
  } finally {
    h.close()
  }
})

test('toolbox calls are proxied with Toolbox\'s own key', async () => {
  const h = await start()
  try {
    const r = await h.call('/toolbox/items?x=1')
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { path: '/api/items?x=1' })
  } finally {
    h.close()
  }
})

test('with shared config, the Skills, Agents and MCP pages are served here for both agents', async () => {
  const calls: unknown[] = []
  const shared = {
    installed: () => ({ claude: true, codex: true }),
    items: async () => ({ skill: [{ id: 's', name: 's', description: '', has: 'both' }], agent: [], mcp: [] }),
    read: async (kind: string, id: string) => ({ content: `${kind}:${id}` }),
    save: async (...a: unknown[]) => { calls.push(['save', ...a]); return a[1] === 'bad' ? Promise.reject(new Error('Nope')) : {} },
    remove: async (...a: unknown[]) => { calls.push(['remove', ...a]) },
    plan: async () => [{ kind: 'skill', id: 's', step: { action: 'same' } }],
    mirror: async (c: unknown) => { calls.push(['mirror', c]); return { done: [], failed: [] } },
    setKey: async (...a: unknown[]) => { calls.push(['key', ...a]) },
  }
  const h = await start({ shared })
  try {
    const items = await (await h.call('/toolbox/items')).json()
    assert.equal(items.skill[0].has, 'both')
    assert.deepEqual(items.installed, { claude: true, codex: true })
    assert.deepEqual(await (await h.call('/toolbox/item?kind=agent&id=a')).json(), { content: 'agent:a' })
    assert.equal((await h.call('/toolbox/item?kind=nope&id=a')).status, 400)
    assert.equal((await h.call('/toolbox/save', { method: 'POST', body: JSON.stringify({ kind: 'skill', id: 's', content: 'c', isNew: true }) })).status, 200)
    const bad = await h.call('/toolbox/save', { method: 'POST', body: JSON.stringify({ kind: 'skill', id: 'bad', content: 'c' }) })
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).error, 'Nope')
    await h.call('/toolbox/delete', { method: 'POST', body: JSON.stringify({ kind: 'mcp', id: 'x' }) })
    assert.equal((await (await h.call('/toolbox/mirror')).json()).steps.length, 1)
    await h.call('/toolbox/mirror', { method: 'POST', body: JSON.stringify({ choices: { 'skill:s': 'codex', 'skill:t': 'evil' } }) })
    await h.call('/toolbox/key', { method: 'POST', body: JSON.stringify({ name: 'K', value: 'v' }) })
    assert.deepEqual(calls, [['save', 'skill', 's', 'c', true], ['save', 'skill', 'bad', 'c', false], ['remove', 'mcp', 'x'], ['mirror', { 'skill:s': 'codex' }], ['key', 'K', 'v']])
    // Anything else still goes to Toolbox.
    assert.deepEqual(await (await h.call('/toolbox/other')).json(), { path: '/api/other' })
  } finally {
    h.close()
  }
})

test('workers list, detail and stop', async () => {
  const h = await start()
  try {
    assert.equal((await (await h.call('/workers')).json()).workers[0].state, 'needs')
    assert.equal((await (await h.call('/workers/cc-x')).json()).job, 'Dark theme')
    assert.equal((await h.call('/workers/nope')).status, 404)
    assert.equal((await h.call('/workers/cc-x/stop', { method: 'POST' })).status, 200)
    assert.deepEqual(stopped, ['cc-x'])
  } finally {
    h.close()
  }
})

test('Change it uses the chosen model; without one Toolbox drafts', async () => {
  const h = await start()
  try {
    const body = (model?: string) => JSON.stringify({ kind: 'skill', id: 'catch-up', current: 'old', request: 'move it up', model, effort: 'high' })
    const r = await h.call('/toolbox/draft', { method: 'POST', body: body('claude:opus') })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { id: 'catch-up', summary: 'Moved it up.', content: '---\nname: catch-up\n---\nnew' })
    const bad = await h.call('/toolbox/draft', { method: 'POST', body: body('local:qwen2.5-3b') })
    assert.equal(bad.status, 502)
    assert.match((await bad.json()).error, /usable draft/)
    assert.deepEqual(drafts, ['claude:opus:high', 'local:qwen2.5-3b'])
    assert.equal((await h.call('/toolbox/draft', { method: 'POST', body: body('claude:gpt') })).status, 400)
    // No model: proxied to Toolbox (the stand-in echoes the path).
    assert.deepEqual(await (await h.call('/toolbox/draft', { method: 'POST', body: body() })).json(), { path: '/api/draft' })
  } finally {
    h.close()
  }
})

test('browsers sign in with Access; pages are public; changes need same origin', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = mkdtempSync('/tmp/limeade-')
  writeFileSync(join(dir, 'index.html'), '<script src="/app.js?v=4"></script><link href="/styles.css">')
  writeFileSync(join(dir, 'styles.css'), 'body{}')
  writeFileSync(join(dir, 'app.js'), 'console.log(1)')
  const h = await start({ webDir: dir, access: { emailFor: async (hd: any) => (hd['cf-access-jwt-assertion'] === 'ok' ? 'b@x' : null) } })
  try {
    const page = await fetch(`${h.base}/`)
    const html = await page.text()
    const js = /"\/app\.([0-9a-f]{10})\.js"/.exec(html)
    assert.ok(js, html)
    assert.match(html, /"\/styles\.[0-9a-f]{10}\.css"/)
    const asset = await fetch(`${h.base}/app.${js![1]}.js`)
    assert.equal(await asset.text(), 'console.log(1)')
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/)
    assert.equal((await fetch(`${h.base}/status`)).status, 401)
    assert.equal((await fetch(`${h.base}/status`, { headers: { 'cf-access-jwt-assertion': 'nope' } })).status, 401)
    assert.equal((await fetch(`${h.base}/status`, { headers: { 'cf-access-jwt-assertion': 'ok' } })).status, 200)
    const post = (origin: string) => fetch(`${h.base}/chats`, { method: 'POST', body: '{}', headers: { 'cf-access-jwt-assertion': 'ok', origin, 'content-type': 'application/json' } })
    assert.equal((await post('https://evil.example')).status, 403)
    assert.equal((await post(h.base)).status, 201)
    assert.equal((await h.call('/status')).status, 200) // the key still works for scripts
  } finally {
    h.close()
  }
})

test('without Access, the browser on this computer is the owner: localhost only, same origin, never through a proxy', async () => {
  const h = await start({ trustedHosts: ['mac.tail.ts.net'] })
  try {
    assert.equal((await fetch(`${h.base}/status`)).status, 200)
    const post = (headers: Record<string, string>) => fetch(`${h.base}/chats`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...headers } })
    assert.equal((await post({ origin: h.base })).status, 201)
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(`${h.base}/status`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 401)
  } finally {
    h.close()
  }
  const { isLocalDevRequest } = await import('../src/adapters/http.ts')
  const req = (host: string, addr = '127.0.0.1', extra: Record<string, string> = {}) => ({ socket: { remoteAddress: addr }, headers: { host, ...extra } }) as any
  assert.equal(isLocalDevRequest(req('localhost:8797')), true)
  assert.equal(isLocalDevRequest(req('evil.example:8797')), false) // a DNS trick lands on 127.0.0.1 with its own name
  assert.equal(isLocalDevRequest(req('Mac.tail.ts.net'), ['mac.tail.ts.net']), true) // tailscale serve, set up by the user
  assert.equal(isLocalDevRequest(req('localhost', '203.0.113.20')), false)
})

test('push/watching: only a subscribed device can say it is showing the chat', async () => {
  const { ChatWatchers } = await import('../src/domain/chat-watch.ts')
  const watchers = new ChatWatchers()
  const known = 'https://push.example/1'
  const subscribers = { find: (e: string) => (e === known ? { subscription: { endpoint: e }, kinds: {} } : undefined) }
  const h = await start({ push: { publicKey: 'k', subscribers, out: {}, watchers }, now: () => 1000 })
  try {
    const say = (endpoint: string, watching: boolean) => h.call('/push/watching', { method: 'POST', body: JSON.stringify({ endpoint, watching }) }).then((r) => r.json())
    assert.deepEqual(await say(known, true), { watching: true })
    assert.equal(watchers.isWatching(known, 1000), true)
    assert.deepEqual(await say('https://push.example/stranger', true), { watching: false })
    assert.equal(watchers.isWatching('https://push.example/stranger', 1000), false)
    await say(known, false)
    assert.equal(watchers.isWatching(known, 1000), false)
  } finally {
    h.close()
  }
})

test('places and folders: machines, recent folders, browsing and search, never outside home', async () => {
  const folders = {
    home: '/h',
    resolve: async (p: string) => ({ '~': '/h', '/h': '/h', '~/dev': '/h/dev', '/h/dev': '/h/dev' } as Record<string, string>)[p] ?? null,
    list: async (p: string, o?: { hidden?: boolean }) => (p === '/h' ? ['/h/dev', ...(o?.hidden ? ['/h/.config'] : [])] : []),
    search: async (q: string) => (q === 'dev' ? ['/h/dev'] : []),
  }
  const h = await start({ folders, defaultFolder: '/h/dev' })
  try {
    const places = await (await h.call('/places')).json()
    assert.deepEqual(places.machines.map((m: any) => [m.id, m.online]), [['homelab', true]])
    assert.deepEqual(places.defaultFolder, { path: '/h/dev', display: '~/dev' })

    const home = await (await h.call('/folders')).json()
    assert.equal(home.display, '~')
    assert.equal(home.parent, null)
    assert.deepEqual(home.folders, [{ path: '/h/dev', display: '~/dev', name: 'dev' }])
    assert.equal((await (await h.call('/folders?path=~&hidden=1')).json()).folders.length, 2)
    const dev = await (await h.call('/folders?path=~/dev')).json()
    assert.equal(dev.parent.display, '~')
    assert.equal((await h.call('/folders?path=/etc')).status, 404)
    assert.deepEqual((await (await h.call('/folders?q=dev')).json()).folders.map((f: any) => f.display), ['~/dev'])
    assert.equal((await fetch(`${h.base}/folders`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 401) // behind the same sign-in as everything else
  } finally {
    h.close()
  }
})

test('files a reply links to open from home, sandboxed, and nothing outside home does', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-files-')))
  const home = join(root, 'home')
  mkdirSync(join(home, 'dev/purger'), { recursive: true })
  writeFileSync(join(home, 'dev/purger/diagram.html'), '<h1>Purger</h1>')
  writeFileSync(join(home, 'dev/purger/my notes.bin'), 'x')
  writeFileSync(join(root, 'outside.html'), 'no')
  const h = await start({ files: new HomeFolderTree(home) })
  try {
    // The link md.js makes for [Open Purger diagram](<home>/dev/purger/diagram.html).
    const r = await h.call(`/files${home}/dev/purger/diagram.html`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(r.headers.get('content-security-policy')!, /^sandbox allow-scripts/) // never runs as Limeade
    assert.equal(await r.text(), '<h1>Purger</h1>')
    assert.equal((await h.call('/files/~/dev/purger/diagram.html')).status, 200)
    const other = await h.call(`/files${home}/dev/purger/my%20notes.bin`)
    assert.match(other.headers.get('content-disposition')!, /^attachment/)
    await other.text()
    assert.equal((await h.call(`/files${root}/outside.html`)).status, 404)
    assert.equal((await h.call(`/files${home}/dev/purger`)).status, 404)
    assert.equal((await h.call('/files/~/%2E%2E/outside.html')).status, 404)
    assert.equal((await h.call('/files/~/%E0')).status, 400)
    assert.equal((await fetch(`${h.base}/files/~/dev/purger/diagram.html`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 401)
  } finally {
    h.close()
  }
})

test('a file link with :line opens the file at that line, and one that cannot open says so in a page (issue #15)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-lines-')))
  const home = join(root, 'home')
  const dir = join(home, 'dev/purger/src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Test.java'), Array.from({ length: 80 }, (_, i) => `// line ${i + 1} <b>`).join('\n'))
  writeFileSync(join(dir, 'My Test.java'), 'class T {}')
  writeFileSync(join(dir, 'notes:7'), 'a file whose name really ends in :7')
  writeFileSync(join(dir, 'diagram.html'), '<h1>d</h1>')
  writeFileSync(join(dir, 'app.js'), 'go()')
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2]))
  writeFileSync(join(root, 'outside.java'), 'no')
  symlinkSync(join(root, 'outside.java'), join(dir, 'link.java'))
  const h = await start({ files: new HomeFolderTree(home) })
  const page = { headers: { 'sec-fetch-dest': 'document' } }
  try {
    // What md.js makes of [Failure logging](<home>/dev/purger/src/Test.java:72): the ":" encoded into the name.
    const at = async (p: string) => (await h.call(p, { redirect: 'manual' })).headers.get('location')
    assert.equal(await at(`/files${home}/dev/purger/src/Test.java%3A72`), `/files${home}/dev/purger/src/Test.java#L72`)
    assert.equal(await at(`/files${home}/dev/purger/src/Test.java:72:5`), `/files${home}/dev/purger/src/Test.java#L72`)
    assert.equal(await at('/files/~/dev/purger/src/My%20Test.java%3A3'), '/files/~/dev/purger/src/My%20Test.java#L3')
    assert.equal((await h.call(`/files${home}/dev/purger/src/Test.java%3A72`)).status, 200) // followed, it opens
    // Without a line, and a file that really is named "notes:7", open as they are.
    assert.equal((await h.call(`/files${home}/dev/purger/src/Test.java`)).status, 200)
    assert.equal(await (await h.call('/files/~/dev/purger/src/notes%3A7')).text(), 'a file whose name really ends in :7')
    // A line on a missing file, outside home, through "..", or through a link out of home: still refused.
    for (const p of [`${home}/dev/purger/src/Nope.java%3A3`, `${root}/outside.java%3A1`, '~/dev/%2E%2E/%2E%2E/outside.java%3A1', `${home}/dev/purger/src/link.java%3A1`]) {
      assert.equal((await h.call(`/files/${p.replace(/^\//, '')}`, { redirect: 'manual' })).status, 404, p)
    }

    // Tapped, a text file opens as numbered lines (escaped, no scripts), so #L72 lands on line 72.
    const src = await h.call(`/files${home}/dev/purger/src/Test.java`, page)
    assert.equal(src.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(src.headers.get('content-security-policy')!, /default-src 'none'.*sandbox/)
    const html = await src.text()
    assert.match(html, /<div class="l" id="L72"><a href="#L72">72<\/a><span>\/\/ line 72 &lt;b&gt;<\/span><\/div>/)
    assert.doesNotMatch(html, /<script/)
    // Pages, binaries, and a page's own script loaded by it, stay as they were.
    assert.equal(await (await h.call(`/files${home}/dev/purger/src/diagram.html`, page)).text(), '<h1>d</h1>')
    assert.match((await h.call(`/files${home}/dev/purger/src/blob.bin`, page)).headers.get('content-disposition')!, /^attachment/)
    const script = await h.call(`/files${home}/dev/purger/src/app.js`, { headers: { 'sec-fetch-dest': 'script' } })
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(await script.text(), 'go()')

    // A file that can't open: a page that says why with a way back, not raw JSON; scripts still get JSON.
    const missing = await h.call(`/files${home}/dev/purger/src/Nope.java%3A3`, page)
    assert.equal(missing.status, 404)
    const text = await missing.text()
    assert.match(text, /not inside your home folder, or does not exist/)
    assert.match(text, /<a href="\/">Back to Limeade<\/a>/)
    assert.deepEqual(await (await h.call(`/files${home}/dev/purger/src/Nope.java`)).json(), { error: 'That file is not inside your home folder, or does not exist' })
  } finally {
    h.close()
  }
})

test('local models: list, pull, cancel and remove go to the right machine; bad names and machines are refused', async () => {
  const seen: string[] = []
  const gpu = { id: 'gpu', label: 'GPU box', short: 'GPU', url: 'http://gpu', prefix: '', fitsGb: 6.5, maxGb: 8 }
  const machineModels = new MachineModels({
    machines: [gpu],
    notes: {},
    gate: new RestartGate(),
    library: { models: async () => ({ models: [], fetchedAt: null, fallback: true }), tags: async () => [] },
    file: { read: async () => null, write: async () => {}, restart: async () => {} },
    ollama: {
      installed: async () => [{ tag: 'tiny:1b', size: 7e8, parameterSize: '1B', capabilities: ['completion'] }],
      pull: (_m, tag, signal) => { seen.push(`pull ${tag}`); return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) },
      remove: async (_m, tag) => { seen.push(`remove ${tag}`) },
    },
  })
  const h = await start({ machineModels })
  try {
    const list = await (await h.call('/local-models')).json()
    assert.equal(list.machines[0].models[0].tag, 'tiny:1b')
    assert.equal(list.machines[0].models[0].tools, false)
    const post = (path: string, body: unknown) => h.call(path, { method: 'POST', body: JSON.stringify(body) })
    assert.equal((await post('/local-models/gpu/pull', { name: 'http://x' })).status, 400)
    assert.equal((await post('/local-models/nas/pull', { name: 'qwen3' })).status, 404)
    assert.equal((await post('/local-models/gpu/pull', { name: 'qwen3:8b' })).status, 202)
    assert.equal((await post('/local-models/gpu/pull', { name: 'qwen3:4b' })).status, 409)
    assert.deepEqual(await (await post('/local-models/gpu/cancel', {})).json(), { cancelled: true })
    assert.equal((await h.call('/local-models/gpu/models/nope%3A1b', { method: 'DELETE' })).status, 404)
    assert.equal((await h.call('/local-models/gpu/models/tiny%3A1b', { method: 'DELETE' })).status, 200)
    assert.deepEqual(seen, ['pull qwen3:8b', 'remove tiny:1b'])
  } finally {
    h.close()
  }
})

test('the Claude-through-ACP setting is off until turned on, and only takes true or false', async () => {
  let data: Record<string, string> = {}
  const settings = { get: () => data, set: async (k: string, v: string) => { data = { ...data, [k]: v } } }
  const h = await start({ settings })
  try {
    assert.equal((await (await h.call('/settings')).json()).claudeAcp, false)
    assert.equal((await h.call('/settings', { method: 'PUT', body: JSON.stringify({ claudeAcp: 'yes' }) })).status, 400)
    assert.equal((await (await h.call('/settings', { method: 'PUT', body: JSON.stringify({ claudeAcp: true }) })).json()).claudeAcp, true)
    assert.equal(data.claudeAcp, 'on')
    assert.equal((await (await h.call('/settings')).json()).claudeAcp, true)
  } finally {
    h.close()
  }
})

test('the model list says whether Codex is there and signed in, and shows its models once installed', async () => {
  let status = { installed: false, signedIn: false }
  const h = await start({ codex: { status: async () => status } })
  try {
    let models = await (await h.call('/models')).json()
    assert.deepEqual(models.agents.codex, { installed: false, signedIn: false })
    assert.deepEqual(models.groups.map((g: any) => g.engine), ['claude', 'local'])
    status = { installed: true, signedIn: false }
    models = await (await h.call('/models')).json()
    assert.deepEqual(models.groups.map((g: any) => [g.engine, g.online]), [['claude', true], ['codex', false], ['local', true]])
    // Toolbox drafts never run on Codex.
    const draft = await h.call('/toolbox/draft', { method: 'POST', body: JSON.stringify({ kind: 'skill', model: 'codex:gpt-6.1-sol', request: 'x' }) })
    assert.equal(draft.status, 400)
  } finally {
    h.close()
  }
  const plain = await start()
  try {
    assert.equal((await (await plain.call('/models')).json()).agents.codex, undefined) // a hub without Codex: no switch
  } finally {
    plain.close()
  }
})

test('Settings › Agents over HTTP: list, install, sign in, code, keys; the model list follows Claude too', async () => {
  const calls: string[] = []
  const view = (agent: string) => ({ agent, name: agent, status: { installed: true, signedIn: false }, pinned: '1.0.0', update: null, install: null, signIn: null, keySaved: false })
  const { EventEmitter } = await import('node:events')
  const agents = Object.assign(new EventEmitter(), {
    list: async () => [view('claude'), view('codex')],
    get: async (a: string) => view(a),
    install: async (a: string) => { calls.push(`install ${a}`); return view(a) },
    startSignIn: async (a: string, how: string) => { calls.push(`sign-in ${a} ${how}`); return view(a) },
    cancelSignIn: async (a: string) => { calls.push(`cancel ${a}`); return view(a) },
    sendCode: async (a: string, code: string) => { calls.push(`code ${a} ${code}`); return view(a) },
    saveKey: async (a: string, key: string) => { calls.push(`key ${a} ${key}`); return view(a) },
    removeKey: async (a: string) => { calls.push(`unkey ${a}`); return view(a) },
  })
  const h = await start({ agents, claude: { status: async () => ({ installed: true, signedIn: false }) } })
  try {
    assert.deepEqual((await (await h.call('/agents')).json()).agents.map((a: any) => a.agent), ['claude', 'codex'])
    assert.equal((await (await h.call('/agents/codex')).json()).agent, 'codex')
    assert.equal((await h.call('/agents/codex/install', { method: 'POST' })).status, 202)
    await h.call('/agents/claude/sign-in', { method: 'POST', body: JSON.stringify({ how: 'subscription' }) })
    await h.call('/agents/claude/sign-in/code', { method: 'POST', body: JSON.stringify({ code: 'c#s' }) })
    await h.call('/agents/claude/sign-in', { method: 'DELETE' })
    await h.call('/agents/codex/key', { method: 'PUT', body: JSON.stringify({ key: 'sk-x' }) })
    await h.call('/agents/codex/key', { method: 'DELETE' })
    assert.deepEqual(calls, ['install codex', 'sign-in claude subscription', 'code claude c#s', 'cancel claude', 'key codex sk-x', 'unkey codex'])
    assert.equal((await h.call('/agents/codex/nope', { method: 'POST' })).status, 404)
    const models = await (await h.call('/models')).json()
    assert.deepEqual(models.agents.claude, { installed: true, signedIn: false })
    assert.deepEqual([models.groups[0].title, models.groups[0].online], ['Claude · not signed in', false])
  } finally {
    h.close()
  }
  const plain = await start()
  try {
    assert.equal((await plain.call('/agents')).status, 503)
  } finally {
    plain.close()
  }
})
