// Runs one agent turn through ACP (the Agent Client Protocol): Claude Code through the Claude ACP adapter,
// Codex through the Codex ACP adapter. The engine is the same for both; an AcpAgent says what differs (the
// adapter's environment, the session's options and modes, how its tool calls read). Each turn runs in a
// keeper (acp-keeper.ts) that outlives the hub.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { stepFor, type Step } from '../domain/chat.ts'
import type { ApprovalDecision, ApprovalRequest, EngineEvent, SteerMessage, TurnEngine, TurnRequest, TurnResult } from '../ports.ts'
import type { AcpTurnSpec } from './acp-keeper.ts'
import { userContent } from './claude-cli.ts'
import { KEEPER_FILES, allowSteers, recordSteer, steerIds } from './turn-files.ts'

const KEEPER = fileURLToPath(new URL('./acp-keeper.ts', import.meta.url))
const STARTED = 'started'

/** A tool call as the app's tool name and input (Claude Code's names: Bash, Read, Edit…). */
export interface AcpTool {
  name: string
  input: Record<string, unknown>
  /** A subagent's own call: it stays inside the subagent's step. */
  child?: boolean
}

/** What one agent's adapter needs that another's doesn't. */
export interface AcpAgent {
  /** Said in failures: "Claude", "Codex". */
  name: string
  /** Its turns' handles (and folders) start with this, so a kept turn goes back to the right engine. */
  handlePrefix: string
  /** The adapter's environment and the session for one turn. */
  turn(req: TurnRequest): Promise<{ env: Record<string, string>; spec: Omit<AcpTurnSpec, 'sessionId' | 'prompt'>; inlinePhotos: boolean }>
  /** A tool call (or permission request's toolCall) as the app's tool; null when it isn't a step (thinking). */
  tool(call: any): AcpTool | null
  /** Which Claude version an alias is, from an update; Claude only. */
  modelOf?(update: any): string | undefined
  /** Text the agent sends that isn't part of its reply (Codex's model-metadata warnings). */
  noise?(update: any): boolean
  /** Friendlier words for a failure, when there are any (Codex not signed in). */
  failure?(e: { error?: string; stage?: string; code?: number }): string | undefined
}

export interface AcpTurnsOptions {
  /** How to start the adapter: usually node and its dist/index.js. */
  adapter: { bin: string; args: string[] }
  cwd: string
  turnsDir: string
  turnTimeoutMs: number
  killGraceMs?: number
  env?: NodeJS.ProcessEnv
  /** Keys MCP servers need (from Limeade's key store), read at each start so a new key counts at once. */
  keys?: () => Record<string, string>
  /** Folders outside cwd the agent may read without asking (the uploads folder). */
  addDirs?: readonly string[]
}

/** An installed package's entry point (dist/index.js). */
export function packageEntry(name: string): string {
  return fileURLToPath(import.meta.resolve(`${name}/package.json`).replace(/package\.json$/, 'dist/index.js'))
}

/** An executable's absolute path: as given when it has a slash, else the first match on PATH. */
export function onPath(bin: string, pathVar = process.env.PATH ?? ''): string {
  if (bin.includes('/')) return bin
  for (const d of pathVar.split(delimiter)) {
    const p = join(d, bin)
    try {
      if (statSync(p).isFile()) return p
    } catch {}
  }
  return bin
}

/** The hub's user content (claude-cli.ts's userContent) as ACP content blocks. */
export function acpPrompt(content: Awaited<ReturnType<typeof userContent>>): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map((b) => (b.type === 'image' ? { type: 'image', mimeType: b.source.media_type, data: b.source.data } : { type: 'text', text: b.text }))
}

export interface PermissionOption {
  optionId: string
  name?: string
  kind?: string
}

/** A permission request as the app's approval card. */
export function approvalFor(params: any, toolOf: AcpAgent['tool']): ApprovalRequest {
  const call = params?.toolCall ?? {}
  const t = toolOf(call) ?? { name: String(call.title ?? 'Tool'), input: {} }
  const step = stepFor(t.name, t.input)
  return {
    tool: step.tool,
    text: step.text || String(call.title ?? ''),
    description: typeof t.input.description === 'string' ? t.input.description : '',
    alwaysLabel: /PlanMode$/.test(t.name) ? '' : alwaysWords((params?.options as PermissionOption[] | undefined)?.find((o) => o.kind === 'allow_always')?.name),
  }
}

/**
 * What "Yes, and don't ask again for …" would allow, from the adapter's option name ("Yes, and don't ask
 * again for npm test commands", "Yes, and allow access to work/"). Empty (not offered) when the option
 * says something else: the plan-mode exits are mode switches, not remembered rules.
 */
function alwaysWords(name: string | undefined): string {
  const m = /^yes,?\s*and\s+(?:don't|do not)\s+ask\s+again\s+for\s+(.+)$/i.exec(name ?? '') ?? /^yes,?\s*and\s+allow\s+(.+)$/i.exec(name ?? '')
  return m?.[1]?.trim() ?? ''
}

/** Which offered option a decision picks ("always" falls back to once when it can't be remembered). */
export function optionFor(decision: ApprovalDecision, options: readonly PermissionOption[] = []): string | null {
  const kind = (k: string) => options.find((o) => o.kind === k)?.optionId
  if (decision === 'no') return kind('reject_once') ?? kind('reject_always') ?? null
  if (decision === 'always') return kind('allow_always') ?? kind('allow_once') ?? null
  return kind('allow_once') ?? kind('allow_always') ?? null
}

/**
 * Turns a session's updates into the app's events: the streamed text (a blank line between the agent's
 * messages, like the CLI path), a step per tool call once its input is known, and which Claude version an
 * alias is. Subagents' own tool calls stay inside their step, as on the CLI path.
 */
export class AcpReplyReader {
  /** Everything streamed. */
  text = ''
  /** The latest message alone: the reply, like the CLI's result. */
  last = ''
  private messageId: string | null = null
  private toolSince = false
  private tools = new Map<string, boolean>()
  private modelSeen = false
  private o: { alias: string; reportModel: boolean; agent: Pick<AcpAgent, 'tool' | 'modelOf' | 'noise'> }
  constructor(o: AcpReplyReader['o']) {
    this.o = o
  }

  read(update: any): EngineEvent[] {
    const out: EngineEvent[] = []
    const kind = update?.sessionUpdate
    const modelId = this.o.agent.modelOf?.(update)
    if (this.o.reportModel && !this.modelSeen && typeof modelId === 'string' && modelId) {
      this.modelSeen = true
      out.push({ type: 'model', alias: this.o.alias, modelId })
    }
    if (kind === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text) {
      if (this.o.agent.noise?.(update)) return out
      const id = typeof update.messageId === 'string' ? update.messageId : null
      const fresh = id ? id !== this.messageId : this.toolSince
      if (id) this.messageId = id
      this.toolSince = false
      const brk = fresh && this.text ? '\n\n' : ''
      if (fresh) this.last = ''
      this.text += brk + update.content.text
      this.last += update.content.text
      out.push({ type: 'text', text: brk + update.content.text })
    } else if ((kind === 'tool_call' || kind === 'tool_call_update') && update.toolCallId) {
      const id = String(update.toolCallId)
      if (this.tools.get(id)) return out
      const tool = this.o.agent.tool(update)
      if (tool?.child) return out
      if (!this.tools.has(id)) this.tools.set(id, false)
      this.toolSince = true
      if (!tool) {
        this.tools.set(id, true)
        return out
      }
      const known = Object.keys(tool.input).length > 0
      const running = update.status === 'in_progress' || update.status === 'completed' || update.status === 'failed'
      if (!known && !running) return out
      this.tools.set(id, true)
      out.push({ type: 'step', step: stepFor(tool.name, tool.input) })
    }
    return out
  }
}

/** One agent's turns through its ACP adapter, each in a keeper that outlives the hub. */
export class AcpTurns implements TurnEngine {
  protected o: AcpTurnsOptions
  protected agent: AcpAgent
  constructor(o: AcpTurnsOptions, agent: AcpAgent) {
    this.o = o
    this.agent = agent
  }

  /** Adapters still winding down after their answer, by session; a resume waits for them (briefly). */
  private closing = new Map<string, Promise<void>>()

  async run(req: TurnRequest): Promise<TurnResult> {
    const prev = req.sessionId ? this.closing.get(req.sessionId) : undefined
    if (prev) await Promise.race([prev, new Promise((r) => setTimeout(r, 15_000))])
    let turn: Awaited<ReturnType<AcpAgent['turn']>>
    try {
      turn = await this.agent.turn(req)
    } catch (err) {
      return { text: '', sessionId: req.sessionId, error: (err as Error).message }
    }
    let prompt: unknown[]
    try {
      prompt = acpPrompt(await userContent(req.prompt, req.attachments, undefined, turn.inlinePhotos))
    } catch (err) {
      return { text: '', sessionId: req.sessionId, error: `couldn't read an attached file (${(err as Error).message})` }
    }
    const handle = this.agent.handlePrefix + randomUUID()
    const dir = join(this.o.turnsDir, handle)
    const spec: AcpTurnSpec = { sessionId: req.sessionId, ...turn.spec, prompt }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, KEEPER_FILES.first), JSON.stringify(spec), { mode: 0o600 })
      writeFileSync(join(dir, STARTED), String(Date.now()), { mode: 0o600 })
      allowSteers(dir)
    } catch (err) {
      return { text: '', sessionId: req.sessionId, error: `couldn't start the turn (${(err as Error).message})` }
    }
    const keeper = spawn(process.execPath, [KEEPER, dir, String(this.o.turnTimeoutMs + 120_000), this.o.adapter.bin, ...this.o.adapter.args], {
      cwd: req.cwd ?? this.o.cwd,
      env: { ...process.env, ...this.o.keys?.(), ...this.o.env, ...turn.env, ...req.env },
      stdio: 'ignore',
      // Its own process, not tied to the hub: a hub restart leaves it (and the adapter) running.
      detached: true,
    })
    keeper.on('error', (err) => {
      try {
        writeFileSync(join(dir, KEEPER_FILES.exit), JSON.stringify({ code: null, signal: null, error: err.message }), { mode: 0o600 })
      } catch {}
    })
    keeper.unref()
    req.onStart?.(handle)
    return (await this.follow(dir, req, false, turn.inlinePhotos)) ?? { text: '', sessionId: req.sessionId, error: 'the turn ended without a word' }
  }

  async reattach(handle: string, req: TurnRequest): Promise<TurnResult | null> {
    if (!handle.startsWith(this.agent.handlePrefix) || !/^[0-9a-f-]{36}$/.test(handle.slice(this.agent.handlePrefix.length))) return null
    const dir = join(this.o.turnsDir, handle)
    if (!existsSync(join(dir, STARTED))) return null
    // Photos steered into a picked-up turn go by path: whether this agent sees them inline isn't kept.
    return this.follow(dir, req, true, false)
  }

  /** Whether the agent's version of a model (Claude's alias → id) should be reported. */
  protected reportsModel(_req: TurnRequest): boolean {
    return false
  }

  /** Reads a kept turn's output from the start and talks to its adapter. Null when the keeper vanished. */
  private follow(dir: string, req: TurnRequest, resumed: boolean, inlinePhotos: boolean): Promise<TurnResult | null> {
    return new Promise((resolve) => {
      const file = (f: string) => join(dir, f)
      const reader = new AcpReplyReader({ alias: req.model, reportModel: this.reportsModel(req), agent: this.agent })
      let session: string | null = req.sessionId
      let end: { stopReason?: string; error?: string; stage?: string; code?: number } | null = null
      let killTimer: NodeJS.Timeout | undefined
      let timedOut = false
      let finished = false
      let live = !resumed
      const replaySteps: Step[] = []
      // Requests from the adapter not answered yet, by id (JSON), in order.
      const open = new Map<string, any>()
      const answered = resumed ? answeredIds(file(KEEPER_FILES.answered)) : new Set<string>()
      // His messages sent into this turn (steering), until the keeper says how each went.
      const steerable = steerIds(dir)
      const unanswered = new Set(steerable ?? [])
      const told = new Map<string, (took: boolean) => void>()
      let endSeenAt = 0

      let sock: Socket | null = null
      let sockGone = false
      const outbox: string[] = []
      const write = (obj: unknown) => {
        const line = JSON.stringify(obj) + '\n'
        if (sock && !sock.destroyed) sock.write(line)
        else outbox.push(line)
      }
      const connectBy = Date.now() + (resumed ? 3_000 : 15_000)
      const connect = () => {
        if (finished) return
        const s = createConnection(file(KEEPER_FILES.socket))
        s.on('connect', () => {
          sock = s
          for (const line of outbox.splice(0)) s.write(line)
        })
        s.on('error', () => {})
        s.on('close', () => {
          const wasOpen = sock === s
          if (wasOpen) sock = null
          if (finished) return
          if (!wasOpen && Date.now() < connectBy && !existsSync(file(KEEPER_FILES.exit))) setTimeout(connect, 50)
          else sockGone = true
        })
      }
      connect()

      const stopNow = () => {
        write({ keeper: 'cancel' })
        killTimer = setTimeout(() => write({ keeper: 'kill' }), this.o.killGraceMs ?? 5_000)
      }
      const startedAt = Number(readText(file(STARTED))) || Date.now()
      const timer = setTimeout(() => {
        timedOut = true
        stopNow()
      }, Math.max(0, startedAt + this.o.turnTimeoutMs - Date.now()))
      req.signal.addEventListener('abort', stopNow, { once: true })

      const ask = (msg: any) => {
        const options = (msg.params?.options ?? []) as PermissionOption[]
        const reply = (result: unknown) => write({ jsonrpc: '2.0', id: msg.id, result })
        req.onEvent({
          type: 'approval',
          request: approvalFor(msg.params, (c) => this.agent.tool(c)),
          answer: (decision: ApprovalDecision, message?: string) => {
            const optionId = optionFor(decision, options)
            reply(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
            // A plain no stops the turn (as on the CLI path); a no with a reason tells the agent why.
            if (decision === 'no') write(message ? { keeper: 'steer', text: message } : { keeper: 'cancel' })
          },
        })
      }
      const handleRequest = (msg: any) => {
        if (msg.method === 'session/request_permission') return ask(msg)
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by the hub' } })
      }

      const onLine = (line: string) => {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg?.keeper === true) {
          if (typeof msg.steered === 'string') {
            unanswered.delete(msg.steered)
            // Taken in after the turn ended is too late to be answered in it.
            told.get(msg.steered)?.(msg.outcome === 'injected' && !end)
            told.delete(msg.steered)
            return
          }
          if (typeof msg.sessionId === 'string' && msg.sessionId) session = msg.sessionId
          if (msg.stopReason || msg.error) end = msg
          return
        }
        if (msg?.method === 'session/update') {
          for (const e of reader.read(msg.params?.update)) {
            if (live) req.onEvent(e)
            else if (e.type === 'step') replaySteps.push(e.step)
          }
        } else if (msg?.method === '$/cancel_request') {
          open.delete(JSON.stringify(msg.params?.requestId ?? msg.params?.id))
        } else if (msg?.method && 'id' in msg && !String(msg.id).startsWith('keeper-')) {
          if (live) handleRequest(msg)
          else if (!answered.has(JSON.stringify(msg.id))) open.set(JSON.stringify(msg.id), msg)
        }
      }

      let fd: number | null = null
      let offset = 0
      const decoder = new StringDecoder('utf8')
      let partial = ''
      const readMore = () => {
        if (fd === null) {
          try {
            fd = openSync(file(KEEPER_FILES.out), 'r')
          } catch {
            return
          }
        }
        const buf = Buffer.alloc(64 * 1024)
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, offset)
          if (n <= 0) break
          offset += n
          partial += decoder.write(buf.subarray(0, n))
          let nl: number
          while ((nl = partial.indexOf('\n')) >= 0) {
            const line = partial.slice(0, nl)
            partial = partial.slice(nl + 1)
            onLine(line)
          }
        }
      }

      let watcher: FSWatcher | null = null
      let goneAt = 0
      let poll: NodeJS.Timeout | undefined
      const tick = () => {
        if (finished) return
        readMore()
        if (!live) {
          // Caught up with what the earlier hub missed: show it, ask what's still open, then stream.
          live = true
          req.onEvent({ type: 'resumed', text: reader.text, steps: replaySteps })
          for (const msg of open.values()) handleRequest(msg)
          open.clear()
          if (steerable && !end) req.onSteerable?.(steer)
        }
        // Steers still out when it ended: wait a moment for the keeper to say how they went.
        if (end && unanswered.size && Date.now() - (endSeenAt ||= Date.now()) < 3_000) return
        if (end) return finish(null, false)
        const exit = readJson(file(KEEPER_FILES.exit))
        if (exit) {
          readMore()
          return finish(exit, false)
        }
        if (sockGone) {
          goneAt ||= Date.now()
          if (Date.now() - goneAt > 1_000) return finish(null, true)
        }
      }

      const finish = (exit: { code: number | null; signal: string | null; error?: string } | null, vanished: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        clearTimeout(killTimer)
        clearInterval(poll)
        watcher?.close()
        req.signal.removeEventListener('abort', stopNow)
        if (fd !== null) closeSync(fd)
        this.tidy(dir, session)
        sock?.end()
        for (const r of told.values()) r(false)
        told.clear()
        const e = end as typeof end
        if (timedOut) {
          const mins = Math.round(this.o.turnTimeoutMs / 60_000)
          return resolve({ text: reader.text, sessionId: session, error: `it ran for more than ${mins} min, so it was stopped` })
        }
        if (req.signal.aborted || (e && !e.error && e.stopReason === 'cancelled')) return resolve({ text: reader.text, sessionId: session })
        // The reply is the agent's last message, like the CLI's result; everything shows while it streams.
        if (e && !e.error && e.stopReason === 'end_turn') return resolve({ text: reader.last || reader.text, sessionId: session })
        if (vanished && !e) return resolve(null)
        const sessionLost = e?.stage === 'resume' && (e.code === -32002 || /not found|no conversation/i.test(e.error ?? ''))
        const why = (e && this.agent.failure?.(e)) || e?.error || (e?.stopReason ? stopWords(e.stopReason, this.agent.name) : '') || exit?.error ||
          lastLine(readText(file(KEEPER_FILES.err))) || `exit ${exit?.code ?? '?'}`
        resolve({ text: reader.text, sessionId: sessionLost ? null : session, error: why, ...(sessionLost ? { sessionLost } : {}) })
      }

      const steer = async (m: SteerMessage): Promise<boolean> => {
        if (finished || end || sockGone) return false
        let prompt: unknown[]
        try {
          prompt = acpPrompt(await userContent(m.prompt, m.attachments, undefined, inlinePhotos))
        } catch {
          return false
        }
        if (finished || end || sockGone) return false
        try {
          recordSteer(dir, m.id)
        } catch {
          return false
        }
        unanswered.add(m.id)
        const took = new Promise<boolean>((r) => told.set(m.id, r))
        write({ keeper: 'steer', id: m.id, prompt })
        return took
      }

      try {
        watcher = watch(dir, () => tick())
        watcher.on('error', () => {})
      } catch {}
      poll = setInterval(tick, 250)
      if (live && steerable) req.onSteerable?.(steer)
      tick()
    })
  }

  /** The answer is in; the folder goes once the adapter has exited, and a resume of its session waits for that. */
  private tidy(dir: string, session: string | null) {
    const exitFile = join(dir, KEEPER_FILES.exit)
    if (existsSync(exitFile)) return rmSync(dir, { recursive: true, force: true })
    try {
      writeFileSync(join(dir, KEEPER_FILES.collected), '', { mode: 0o600 })
    } catch {}
    if (existsSync(exitFile)) return rmSync(dir, { recursive: true, force: true })
    if (!session) return
    const exited = new Promise<void>((r) => {
      const until = Date.now() + 65_000
      const t = setInterval(() => {
        if (!existsSync(dir) || existsSync(exitFile) || Date.now() > until) {
          clearInterval(t)
          r()
        }
      }, 250)
      t.unref()
    })
    this.closing.set(session, exited)
    void exited.then(() => this.closing.get(session) === exited && this.closing.delete(session))
  }
}

function stopWords(reason: string, agent: string): string {
  if (reason === 'max_tokens') return 'the reply hit its length limit'
  if (reason === 'max_turn_requests') return 'it hit its limit of steps'
  if (reason === 'refusal') return `${agent} declined to answer`
  return `it stopped (${reason})`
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function answeredIds(path: string): Set<string> {
  const ids = new Set<string>()
  for (const line of readText(path).split('\n')) {
    try {
      ids.add(JSON.stringify(JSON.parse(line).id))
    } catch {}
  }
  return ids
}

function lastLine(s: string): string {
  return s.trim().split('\n').at(-1)?.slice(0, 300) ?? ''
}
