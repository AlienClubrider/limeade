// HTTP edge, the phone's one front door: key check and limits, chats, the Assistant, approvals,
// the live stream (SSE) and the Toolbox proxy.

import { createReadStream, promises as fs } from 'node:fs'
import { extname } from 'node:path'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { ASSISTANT_ID } from '../domain/chat.ts'
import { isFleetMode } from '../domain/fleet.ts'
import { claudeGroup } from '../domain/models.ts'
import { FailedAuthBan, SlidingWindowLimit, keyMatches } from '../domain/limits.ts'
import { HubError, type Conversations } from '../app/conversations.ts'
import type { AgentSetup, FleetModeStore, HomeFiles, HomeFolders, KeyValue, LocalModels, NoticeLog, OneShot, WorkerSource } from '../ports.ts'
import { displayFolder, machines, recentFolders } from '../domain/places.ts'
import { draftPrompt, isToolKind, parseDraft } from '../domain/toolbox-draft.ts'
import type { AccessCheck } from '../domain/access.ts'
import { ollamaUrl } from '../domain/local-models.ts'
import { isSubscription, kindsFrom } from '../domain/push.ts'
import type { PushOut } from '../app/push.ts'
import type { ChatWatchers } from '../domain/chat-watch.ts'
import type { SubscriberFile } from './web-push.ts'
import { isWebFile, sendWebFile } from './web-files.ts'
import { isEffort } from '../domain/chat.ts'
import { codexGroup, parseModelId } from '../domain/models.ts'
import { MAX_FILE_BYTES, isPreviewableImage, type StoredAttachment } from '../domain/attachments.ts'
import type { MachineModels } from '../app/machine-models.ts'
import type { Agents } from '../app/agents.ts'
import type { SharedConfig } from '../app/shared-config.ts'

export interface HttpOptions {
  key: string
  conversations: Conversations
  notices: NoticeLog
  fleetMode: FleetModeStore
  localModels: LocalModels
  /** Add and remove models on the Ollama machines. */
  machineModels?: MachineModels | null
  claudeVersions: KeyValue
  /** Codex, when this hub can run it: whether it's installed and signed in (for the agent picker). */
  codex?: AgentSetup | null
  /** Claude Code: whether it's installed and signed in. Without it the hub takes Claude as ready. */
  claude?: AgentSetup | null
  /** Settings › Agents: install, sign in, API keys. */
  agents?: Agents | null
  /** Hub settings the user changes in Settings (claudeAcp: 'on' runs Claude through ACP). */
  settings?: KeyValue | null
  toolbox: { url: string; key: string } | null
  /** Skills, agents and MCP servers for Claude Code and Codex together; served here instead of by Toolbox. */
  shared?: SharedConfig | null
  workers: WorkerSource
  /** Folders a plain chat can work in (under home on this box). */
  folders?: HomeFolders | null
  /** Files under home that a reply links to (a diagram, a page), opened from the link. */
  files?: HomeFiles | null
  defaultFolder?: string
  /** Browser sign-in through Cloudflare Access (Limeade). Scripts keep using the bearer key. */
  access?: AccessCheck | null
  /** Local development only: requests from this machine (not through the tunnel) count as the owner. */
  devLogin?: boolean
  /** Straight to one Ollama (no LiteLLM): its address, changed in Settings. */
  ollama?: { url(): string; setUrl(url: string): Promise<void> } | null
  /** This computer's name (Settings, the chat's "where"). */
  machineName?: string
  /** Names besides localhost this computer's page is reached by (a Tailscale name), when there's no Access. */
  trustedHosts?: readonly string[]
  /** Limeade's static files. */
  webDir?: string | null
  /** Web Push for Limeade. */
  push?: { publicKey: string; subscribers: SubscriberFile; out: PushOut; watchers?: ChatWatchers } | null
  /** Models for Toolbox drafts with a chosen model. */
  oneShot: { claude: OneShot; local: OneShot }
  version: string
  now?: () => number
  log?: (line: string) => void
  heartbeatMs?: number
  maxStreams?: number
  turnsPerHour?: number
  uploadsPerHour?: number
}

const SMALL = 64 * 1024
const TOOLBOX_BODY_MAX = 2 * 1024 * 1024

function givenKey(req: IncomingMessage): string | undefined {
  return /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]
}

export function createHub(o: HttpOptions): Server {
  const now = o.now ?? Date.now
  const log = o.log ?? ((l: string) => console.log(l))
  const heartbeatMs = o.heartbeatMs ?? 20_000
  const bans = new FailedAuthBan({ maxFails: 5, windowMs: 60_000, banMs: 15 * 60_000, now })
  const turns = new SlidingWindowLimit({ max: o.turnsPerHour ?? 200, windowMs: 3_600_000, now })
  const uploads = new SlidingWindowLimit({ max: o.uploadsPerHour ?? 120, windowMs: 3_600_000, now })
  const streams = new Set<ServerResponse>()
  const c = o.conversations

  for (const ev of ['message', 'delta', 'live', 'step', 'busy', 'approval', 'approval_done', 'notice', 'chat', 'inbox']) {
    c.on(ev, (data) => broadcast(ev, data))
  }
  for (const ev of ['pull', 'local_models']) o.machineModels?.on(ev, (data) => broadcast(ev, data))
  o.agents?.on('agents', (data) => broadcast('agents', data))

  /** What Settings shows besides notifications: this computer's name, the Ollama address (when it's used directly). */
  function hubSettings() {
    return {
      claudeAcp: o.settings?.get().claudeAcp === 'on',
      machine: o.machineName ?? 'This computer',
      // No Cloudflare Access: Limeade is only on this computer, and phone access is the user's own setup.
      localOnly: !o.access,
      ...(o.ollama ? { ollamaUrl: o.ollama.url() } : {}),
    }
  }

  return createServer(async (req, res) => {
    const started = now()
    const url = new URL(req.url ?? '/', 'http://hub')
    const route = url.pathname
    // Routes and timings only; never bodies, headers or keys.
    res.on('close', () => log(`${req.method} ${redact(route)} ${res.statusCode} ${now() - started}ms`))
    try {
      if (req.method === 'GET' && route === '/health' && !req.headers['cf-connecting-ip']) return json(res, 200, { ok: true })
      // Limeade's page and files hold nothing private.
      if (req.method === 'GET' && o.webDir && isWebFile(route)) return await sendWebFile(res, o.webDir, route)
      const client = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '?')
      // Scripts and the old app: the bearer key. The right key always gets in (a home network shares one
      // IP with stale clients); wrong keys are counted, and a client with too many gets 429 while banned.
      // Browsers: a valid Cloudflare Access token for the user's email.
      const bearer = givenKey(req)
      if (bearer !== undefined) {
        if (!keyMatches(bearer, o.key)) {
          if (bans.isBanned(client)) throw new HubError(429, 'Too many failed attempts; try later')
          bans.recordFailure(client)
          throw new HubError(401, 'Bad or missing key')
        }
      } else if ((o.devLogin || !o.access) && isLocalDevRequest(req, o.access ? [] : o.trustedHosts)) {
        // The browser on this computer (no Cloudflare Access in front): the page is only on 127.0.0.1.
        if (req.method !== 'GET' && req.headers.origin && !sameOrigin(req)) throw new HubError(403, 'Wrong origin')
      } else {
        const email = o.access ? await o.access.emailFor(req.headers) : null
        if (!email) throw new HubError(401, o.access ? 'Sign in through Cloudflare Access' : 'Open Limeade on the computer it runs on')
        // Cookie-authenticated changes must come from this site's own pages.
        if (req.method !== 'GET' && req.headers.origin && !sameOrigin(req)) throw new HubError(403, 'Wrong origin')
      }
      const parts = route.split('/').filter(Boolean)
      const m = req.method

      if (m === 'GET' && route === '/health') return json(res, 200, { ok: true })
      if (m === 'GET' && route === '/status') {
        return json(res, 200, { version: o.version, fleetMode: await o.fleetMode.get(), busy: c.busyChats() })
      }
      if (m === 'GET' && route === '/models') {
        const [local, codex, claude] = await Promise.all([
          o.localModels.groups().catch(() => []),
          o.codex?.status().catch(() => null) ?? null,
          o.claude?.status().catch(() => null) ?? null,
        ])
        // Codex's own models show (not pickable until it's signed in) once it's installed; local models work in it either way.
        return json(res, 200, {
          groups: [claudeGroup(o.claudeVersions.get(), claude ?? undefined), ...(codex?.installed ? [codexGroup(codex)] : []), ...local],
          agents: {
            claude: claude ? { installed: claude.installed, signedIn: claude.signedIn } : { installed: true, signedIn: true },
            ...(o.codex ? { codex: codex ? { installed: codex.installed, signedIn: codex.signedIn } : { installed: false, signedIn: false } } : {}),
          },
        })
      }
      if (parts[0] === 'agents') {
        const a = o.agents
        if (!a) throw new HubError(503, 'Agent setup is not on this hub')
        const agent = parts[1] ? pathPart(parts[1]) : undefined
        if (parts.length === 1 && m === 'GET') return json(res, 200, { agents: await a.list() })
        if (parts.length === 2 && m === 'GET') return json(res, 200, await a.get(agent))
        if (parts.length === 3 && parts[2] === 'install' && m === 'POST') return json(res, 202, await a.install(agent))
        if (parts.length === 3 && parts[2] === 'sign-in' && m === 'POST') return json(res, 200, await a.startSignIn(agent, (await readJson(req, 1024)).how))
        if (parts.length === 3 && parts[2] === 'sign-in' && m === 'DELETE') return json(res, 200, await a.cancelSignIn(agent))
        if (parts.length === 4 && parts[2] === 'sign-in' && parts[3] === 'code' && m === 'POST') return json(res, 200, await a.sendCode(agent, (await readJson(req, 4096)).code))
        if (parts.length === 3 && parts[2] === 'key' && m === 'PUT') return json(res, 200, await a.saveKey(agent, (await readJson(req, 4096)).key))
        if (parts.length === 3 && parts[2] === 'key' && m === 'DELETE') return json(res, 200, await a.removeKey(agent))
      }

      if (parts[0] === 'local-models') return await localModels(parts.slice(1).map(pathPart), m ?? '', req, res)

      if (m === 'GET' && route === '/places') return json(res, 200, places())
      if (m === 'GET' && route === '/folders') return json(res, 200, await folders(url))
      if (m === 'GET' && route.startsWith('/files/')) return await sendHomeFile(res, route)

      // Chats and the Assistant ("assistant" is just a chat id with its own rules).
      if (parts[0] === 'chats') {
        if (parts.length === 1 && m === 'GET') return json(res, 200, { chats: c.list() })
        if (parts.length === 1 && m === 'POST') return json(res, 201, await c.create(await readJson(req, SMALL)))
        const id = parts[1]!
        if (parts.length === 2 && m === 'GET') return json(res, 200, c.get(id))
        if (parts.length === 2 && m === 'PATCH') return json(res, 200, await c.update(id, await readJson(req, SMALL)))
        if (parts.length === 2 && m === 'DELETE') {
          await c.remove(id)
          return json(res, 200, { ok: true })
        }
        if (parts[2] === 'messages' && m === 'POST') {
          const { text, attachments } = await readJson(req, SMALL)
          if (!turns.tryTake()) throw new HubError(429, 'Too many messages this hour')
          return json(res, 202, await c.send(id, text, attachments))
        }
        // A file for the next message: the raw bytes as the body, its name in ?name=.
        if (parts[2] === 'attachments' && parts.length === 3 && m === 'POST') {
          if (Number(req.headers['content-length'] ?? 0) > MAX_FILE_BYTES) {
            throw new HubError(413, `Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB`)
          }
          if (!uploads.tryTake()) throw new HubError(429, 'Too many files this hour')
          return json(res, 201, await c.upload(id, url.searchParams.get('name'), req))
        }
        if (parts[2] === 'attachments' && parts.length === 4 && m === 'GET') {
          return sendAttachment(res, await c.attachment(id, parts[3]!))
        }
        if (parts[2] === 'stop' && m === 'POST') return json(res, 200, { stopped: c.stop(id) })
        if (parts[2] === 'new-session' && m === 'POST' && id === ASSISTANT_ID) {
          await c.newAssistantSession()
          return json(res, 200, { ok: true })
        }
      }
      if (parts[0] === 'inbox') {
        if (parts.length === 1 && m === 'GET') return json(res, 200, { items: c.inboxItems() })
        if (parts[1] === 'test' && m === 'POST') return json(res, 201, await c.testInboxItem())
        if (parts.length === 2 && m === 'DELETE') {
          await c.dismiss(parts[1]!)
          return json(res, 200, { ok: true })
        }
        if (parts[2] === 'reask' && m === 'POST') {
          await c.reask(parts[1]!)
          return json(res, 202, { ok: true })
        }
      }
      if (m === 'GET' && route === '/approvals') return json(res, 200, { approvals: c.pendingApprovals() })
      if (parts[0] === 'approvals' && parts.length === 2 && m === 'POST') {
        const { decision, message } = await readJson(req, SMALL)
        c.answer(parts[1]!, decision, message)
        return json(res, 200, { ok: true })
      }
      if (m === 'GET' && route === '/notices') {
        return json(res, 200, { notices: o.notices.since(Number(url.searchParams.get('since') ?? 0) || 0) })
      }
      if (route === '/fleet-mode' && m === 'GET') return json(res, 200, { mode: await o.fleetMode.get(), ...(o.fleetMode.fixed ? { fixed: true } : {}) })
      if (route === '/fleet-mode' && m === 'PUT') {
        const { mode } = await readJson(req, 1024)
        if (!isFleetMode(mode)) throw new HubError(400, 'mode must be "claude-app" or "app"')
        if (o.fleetMode.fixed) throw new HubError(400, 'Worker news always goes to this Assistant here')
        await o.fleetMode.set(mode)
        broadcast('fleet_mode', { mode })
        return json(res, 200, { mode })
      }
      if (route === '/settings' && m === 'GET') return json(res, 200, hubSettings())
      if (route === '/settings' && m === 'PUT') {
        const body = await readJson(req, 1024)
        if (body.ollamaUrl !== undefined) {
          if (!o.ollama) throw new HubError(400, 'Local models here go through LiteLLM; its machines are set on the server')
          const url = ollamaUrl(body.ollamaUrl)
          if (!url) throw new HubError(400, 'That is not an address like http://localhost:11434')
          await o.ollama.setUrl(url)
          broadcast('local_models', {})
          return json(res, 200, hubSettings())
        }
        const { claudeAcp } = body
        if (typeof claudeAcp !== 'boolean' || !o.settings) throw new HubError(400, 'claudeAcp must be true or false')
        await o.settings.set('claudeAcp', claudeAcp ? 'on' : 'off')
        return json(res, 200, { claudeAcp })
      }
      if (parts[0] === 'workers') {
        if (parts.length === 1 && m === 'GET') return json(res, 200, { workers: await o.workers.list() })
        if (parts.length === 1 && m === 'POST' && o.workers.start) {
          const b = await readJson(req, SMALL)
          const w = await o.workers.start({ persona: String(b.persona ?? ''), title: b.title, folder: b.folder, brief: b.brief, agent: b.agent, model: b.model })
          broadcast('workers', {})
          return json(res, 201, w)
        }
        const w = parts[1] ? await o.workers.get(parts[1]) : null
        if (!w) throw new HubError(404, 'No such worker')
        if (parts.length === 2 && m === 'GET') return json(res, 200, w)
        if (parts[2] === 'messages' && m === 'POST' && o.workers.send) {
          await o.workers.send(w.id, (await readJson(req, SMALL)).text)
          return json(res, 202, { ok: true })
        }
        if (parts[2] === 'stop' && m === 'POST') {
          await o.workers.stop(w.id)
          broadcast('workers', {})
          return json(res, 200, { ok: true })
        }
      }
      if (parts[0] === 'push' && o.push) return await pushRoute(parts[1] ?? '', m ?? '', req, res)
      if (m === 'GET' && route === '/stream') return liveStream(url, res)
      if (route === '/toolbox/draft' && m === 'POST') {
        const raw = await readRaw(req, TOOLBOX_BODY_MAX)
        let b: any
        try {
          b = JSON.parse(raw || '{}')
        } catch {
          throw new HubError(400, 'Body must be JSON')
        }
        // With a model: draft here with that model. Without one: Toolbox drafts as it always has.
        if (b?.model) return json(res, 200, await draftWith(b))
        return await toolboxProxy(req, res, url, raw)
      }
      if (o.shared && parts[0] === 'toolbox') {
        const done = await sharedRoute(o.shared, parts[1] ?? '', m ?? '', url, req, res)
        if (done !== false) return
      }
      if (route.startsWith('/toolbox/')) return await toolboxProxy(req, res, url)
      throw new HubError(404, 'Not found')
    } catch (err) {
      const status = err instanceof HubError ? err.status : 500
      if (!res.headersSent) json(res, status, { error: err instanceof HubError ? err.message : 'Internal error' })
      else res.end()
      if (!(err instanceof HubError)) log(`error on ${redact(route)}: ${(err as Error).message}`)
    }
  })

  /** Web Push: the public key, subscribe with toggles, status, unsubscribe, test, and "showing the chat". */
  async function pushRoute(what: string, m: string, req: IncomingMessage, res: ServerResponse) {
    const p = o.push!
    if (what === 'key' && m === 'GET') return json(res, 200, { publicKey: p.publicKey })
    if (m !== 'POST') throw new HubError(404, 'Not found')
    const b = await readJson(req, SMALL)
    if (what === 'subscribe') {
      if (!isSubscription(b.subscription)) throw new HubError(400, 'Not a push subscription')
      const label = typeof b.label === 'string' ? b.label.slice(0, 80) : ''
      await p.subscribers.put({ subscription: b.subscription, kinds: kindsFrom(b.kinds), label, at: new Date(now()).toISOString() })
      return json(res, 200, { subscribed: true, kinds: kindsFrom(b.kinds) })
    }
    const endpoint = typeof b.endpoint === 'string' ? b.endpoint : ''
    const found = p.subscribers.find(endpoint)
    if (what === 'watching') {
      // The page has a chat in front of the user (or just stopped): no buzz for that chat on this device meanwhile.
      const chatId = typeof b.chatId === 'string' && /^[a-z0-9-]{1,64}$/i.test(b.chatId) ? b.chatId : undefined
      if (found) p.watchers?.report(endpoint, b.watching === true, now(), chatId)
      return json(res, 200, { watching: !!found && b.watching === true })
    }
    if (what === 'status') return json(res, 200, { subscribed: !!found, kinds: found?.kinds ?? kindsFrom({}) })
    if (what === 'unsubscribe') {
      await p.subscribers.remove(endpoint)
      return json(res, 200, { subscribed: false })
    }
    if (what === 'test') {
      if (!found) return json(res, 200, { sent: 0 })
      const sent = await p.out.notice({ seq: 0, at: new Date(now()).toISOString(), kind: 'done', title: 'Limeade', body: 'Test notification: this device will get your updates.', chatId: 'assistant', test: true }, endpoint)
      return json(res, 200, { sent })
    }
    throw new HubError(404, 'Not found')
  }

  /**
   * Local models: GET / (machines, installed, pulls) · GET /library · GET /library/:name (tags) ·
   * POST /:machine/pull {name} · POST /:machine/cancel · DELETE /:machine/models/:tag
   */
  async function localModels(p: string[], m: string, req: IncomingMessage, res: ServerResponse) {
    const mm = o.machineModels
    if (!mm) throw new HubError(503, 'Local models are not set up on this hub')
    if (m === 'GET' && p.length === 0) return json(res, 200, await mm.overview())
    if (m === 'GET' && p[0] === 'library' && p.length === 1) return json(res, 200, await mm.library())
    if (m === 'GET' && p[0] === 'library' && p.length === 2) return json(res, 200, await mm.tags(p[1]))
    if (m === 'POST' && p[1] === 'pull' && p.length === 2) {
      const { name } = await readJson(req, SMALL)
      return json(res, 202, mm.pull(p[0], name))
    }
    if (m === 'POST' && p[1] === 'cancel' && p.length === 2) return json(res, 200, { cancelled: mm.cancel(p[0]) })
    if (m === 'DELETE' && p[1] === 'models' && p.length === 3) {
      await mm.remove(p[0], p[2])
      return json(res, 200, { ok: true })
    }
    throw new HubError(404, 'Not found')
  }

  /** Machines a chat can run on, the default folder and the folders of recent chats. */
  function places() {
    const f = o.folders
    const show = (path: string) => ({ path, display: f ? displayFolder(f.home, path) : path })
    const def = o.defaultFolder ?? f?.home
    return {
      home: f?.home ?? null,
      machines: machines(o.machineName),
      defaultFolder: def ? show(def) : null,
      recent: recentFolders(c.list()).map(show),
    }
  }

  /** One folder's folders (?path=, &hidden=1 for hidden ones too), or a search below home (?q=). */
  async function folders(url: URL) {
    const f = o.folders
    if (!f) throw new HubError(503, 'Folders are not set up on this hub')
    const show = (path: string) => ({ path, display: displayFolder(f.home, path), name: path.split('/').at(-1) ?? path })
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100)
    if (q) return { query: q, folders: (await f.search(q)).map(show) }
    const dir = await f.resolve(url.searchParams.get('path') || '~')
    if (!dir) throw new HubError(404, 'That folder is not inside your home folder, or does not exist')
    const parent = dir === f.home ? null : await f.resolve(dir.slice(0, dir.lastIndexOf('/')) || '/')
    return {
      ...show(dir),
      parent: parent ? show(parent) : null,
      folders: (await f.list(dir, { hidden: url.searchParams.get('hidden') === '1' })).map(show),
    }
  }

  /** A file under home that a reply links to: /files/<absolute path> or /files/~/<path>, so its own relative links work too. */
  async function sendHomeFile(res: ServerResponse, route: string) {
    if (!o.files) throw new HubError(503, 'Files are not set up on this hub')
    let asked: string
    try {
      asked = route.slice('/files/'.length).split('/').map(decodeURIComponent).join('/')
    } catch {
      throw new HubError(400, 'Bad path')
    }
    const path = await o.files.resolveFile(asked.startsWith('~') ? asked : `/${asked}`)
    if (!path) throw new HubError(404, 'That file is not inside your home folder, or does not exist')
    const size = (await fs.stat(path)).size
    if (size > MAX_FILE_BYTES) throw new HubError(413, 'That file is too big to open here')
    sendHomeFileBody(res, path, size)
  }

  /** Live events for the app and its notification service. ?since=<notice seq> replays missed notices. */
  function liveStream(url: URL, res: ServerResponse) {
    sseHead(res)
    if (streams.size >= (o.maxStreams ?? 6)) {
      const oldest = streams.values().next().value
      if (oldest) {
        streams.delete(oldest)
        oldest.end()
      }
    }
    streams.add(res)
    const since = url.searchParams.get('since')
    if (since !== null) for (const n of o.notices.since(Number(since) || 0)) send(res, 'notice', n)
    for (const a of c.pendingApprovals()) send(res, 'approval', a)
    send(res, 'inbox', { items: c.inboxItems() })
    send(res, 'hello', { busy: c.busyChats() })
    const beat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs)
    res.on('close', () => {
      clearInterval(beat)
      streams.delete(res)
    })
  }

  function broadcast(event: string, data: unknown) {
    for (const s of streams) send(s, event, data)
  }

  /** The Skills, Agents and MCP pages, for both agents. False when it's not one of these routes. */
  async function sharedRoute(sc: SharedConfig, what: string, m: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void | false> {
    const kindOf = (v: unknown) => {
      if (!isToolKind(v)) throw new HubError(400, 'Bad kind')
      return v
    }
    const plain = async <T>(f: () => Promise<T>): Promise<T> => {
      try {
        return await f()
      } catch (err) {
        if (err instanceof HubError) throw err
        throw new HubError(400, String((err as any).stderr ?? '').trim() || (err as Error).message)
      }
    }
    if (m === 'GET' && what === 'items') return json(res, 200, { ...(await plain(() => sc.items())), installed: sc.installed() })
    if (m === 'GET' && what === 'item') {
      const kind = kindOf(url.searchParams.get('kind'))
      return json(res, 200, await plain(() => sc.read(kind, url.searchParams.get('id') ?? '')))
    }
    if (m === 'GET' && what === 'mirror') return json(res, 200, { steps: await plain(() => sc.plan()), installed: sc.installed() })
    if (m !== 'POST' || !['save', 'delete', 'mirror', 'key'].includes(what)) return false
    const b = await readJson(req, TOOLBOX_BODY_MAX)
    if (what === 'save') {
      const kind = kindOf(b.kind)
      if (typeof b.id !== 'string' || typeof b.content !== 'string') throw new HubError(400, 'Need an id and content')
      return json(res, 200, { ok: true, ...(await plain(() => sc.save(kind, b.id, b.content, b.isNew === true))) })
    }
    if (what === 'delete') {
      const kind = kindOf(b.kind)
      await plain(() => sc.remove(kind, String(b.id ?? '')))
      return json(res, 200, { ok: true })
    }
    if (what === 'mirror') {
      const choices: Record<string, 'claude' | 'codex' | 'skip'> = {}
      for (const [k, v] of Object.entries(b.choices ?? {})) if (v === 'claude' || v === 'codex' || v === 'skip') choices[k] = v
      return json(res, 200, await plain(() => sc.mirror(choices)))
    }
    if (typeof b.name !== 'string' || typeof b.value !== 'string') throw new HubError(400, 'Need a name and value')
    await plain(() => sc.setKey(b.name, b.value))
    return json(res, 200, { ok: true })
  }

  /** /toolbox/<x> -> Toolbox /api/<x>, with Toolbox's own key added here so the phone needs one key. */
  /** "Change it…" with the model the user picked (Claude via the CLI, local via LiteLLM). */
  async function draftWith(b: any) {
    const parsed = typeof b.model === 'string' ? parseModelId(b.model) : null
    if (!parsed || parsed.engine === 'codex') throw new HubError(400, 'Unknown model')
    if (!isToolKind(b.kind)) throw new HubError(400, 'Bad kind')
    if (typeof b.request !== 'string' || !b.request.trim()) throw new HubError(400, 'Say what you want')
    if (String(b.id ?? '').includes(':')) throw new HubError(400, "This comes from a plugin, so it can't be changed here")
    const current = typeof b.current === 'string' ? b.current : undefined
    const id = typeof b.id === 'string' ? b.id : undefined
    const { system, prompt } = draftPrompt({ kind: b.kind, current, request: b.request.trim(), id })
    try {
      const text = await o.oneShot[parsed.engine as 'claude' | 'local'].complete({
        model: parsed.name,
        effort: isEffort(b.effort) ? b.effort : 'medium',
        system,
        prompt,
        json: true,
      })
      return parseDraft(text, b.kind, id)
    } catch (err) {
      throw new HubError(502, (err as Error).message)
    }
  }

  async function toolboxProxy(req: IncomingMessage, res: ServerResponse, url: URL, rawBody?: string) {
    if (!o.toolbox) throw new HubError(503, 'Toolbox is not set up on this hub')
    const body = req.method === 'GET' ? undefined : rawBody ?? (await readRaw(req, TOOLBOX_BODY_MAX))
    const target = new URL(url.pathname.replace(/^\/toolbox\//, '/api/') + url.search, o.toolbox.url)
    await new Promise<void>((resolve, reject) => {
      const up = httpRequest(target, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          Cookie: `tb=${encodeURIComponent(o.toolbox!.key)}`,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      }, (r) => {
        res.writeHead(r.statusCode ?? 502, { 'Content-Type': r.headers['content-type'] ?? 'application/json', 'Cache-Control': 'no-store' })
        r.pipe(res)
        r.on('end', resolve)
        r.on('error', reject)
      })
      up.on('error', () => reject(new HubError(502, 'Toolbox is not answering')))
      up.end(body)
    })
  }
}

/**
 * A sent file. Only photos open in the page; everything else downloads, typed as plain bytes and boxed
 * in a sandbox, so an uploaded HTML or SVG file can never run as part of Limeade.
 */
function sendAttachment(res: ServerResponse, file: StoredAttachment) {
  const inline = isPreviewableImage(file.type)
  res.writeHead(200, {
    'Content-Type': inline ? file.type : 'application/octet-stream',
    'Content-Length': file.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    // The bytes behind an upload id never change; private keeps them out of Cloudflare's cache.
    'Cache-Control': 'private, max-age=604800, immutable',
  })
  createReadStream(file.path).on('error', () => res.destroy()).pipe(res)
}

/** What a linked file opens as in the browser; anything else downloads. */
const OPENS_AS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
}

/**
 * A linked file. A page may run its own scripts (diagrams usually do), but in a sandbox with no origin of
 * its own, so it can never act as Limeade or read anything of the hub's.
 */
function sendHomeFileBody(res: ServerResponse, path: string, size: number) {
  const type = OPENS_AS[extname(path).toLowerCase()]
  const name = path.split('/').at(-1) ?? 'file'
  res.writeHead(200, {
    'Content-Type': type ?? 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads',
    'Cache-Control': 'no-store',
  })
  createReadStream(path).on('error', () => res.destroy()).pipe(res)
}

/**
 * cloudflared also connects from 127.0.0.1, so a loopback address alone proves nothing: tunnel traffic
 * always carries Cf-* headers, and the Host must be a local name too.
 */
/**
 * A request from a browser on this computer: over loopback, not through Cloudflare, and addressed to
 * localhost (or a name listed as this computer's), so a web page can't reach it through a DNS trick.
 */
export function isLocalDevRequest(req: IncomingMessage, trustedHosts: readonly string[] = []): boolean {
  const addr = req.socket?.remoteAddress ?? ''
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
  const viaCloudflare = Object.keys(req.headers).some((k) => k.startsWith('cf-'))
  return loopback && !viaCloudflare && (host === 'localhost' || host === '127.0.0.1' || trustedHosts.includes(host))
}

/** Changes made with the browser's sign-in must come from this site's own pages. */
function sameOrigin(req: IncomingMessage): boolean {
  try {
    return new URL(String(req.headers.origin)).host === req.headers.host
  } catch {
    return false
  }
}

function pathPart(p: string): string {
  try {
    return decodeURIComponent(p)
  } catch {
    throw new HubError(400, 'Bad path')
  }
}

/** Chat and approval ids are not secret, but keep logs short. */
function redact(route: string): string {
  if (route.startsWith('/files/')) return '/files/…'
  return route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sseHead(res: ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
}

function send(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function readRaw(req: IncomingMessage, max: number): Promise<string> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > max) throw new HubError(413, 'Too big')
  }
  return raw
}

async function readJson(req: IncomingMessage, max: number): Promise<any> {
  const raw = await readRaw(req, max)
  try {
    const v = raw ? JSON.parse(raw) : {}
    return v && typeof v === 'object' ? v : {}
  } catch {
    throw new HubError(400, 'Body must be JSON')
  }
}
