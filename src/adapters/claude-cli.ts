// Runs one turn with the installed Claude Code CLI as this user, on their own sign-in. The hub never
// sees his Claude credentials: the CLI reads its own login. Permission prompts come back over the CLI's
// stdio control protocol and are answered by the user in the app.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { attachmentNote, sendsInline, type StoredAttachment } from '../domain/attachments.ts'
import { cliPermissionMode, stepFor, type Step } from '../domain/chat.ts'
import type { ApprovalDecision, OneShot, TurnEngine, TurnRequest, TurnResult } from '../ports.ts'
import { KEEPER_FILES } from './turn-files.ts'

const KEEPER = fileURLToPath(new URL('./turn-keeper.ts', import.meta.url))
/** When the turn started (ms), so its time limit holds across hub restarts. */
const STARTED = 'started'

export interface ClaudeCliOptions {
  bin: string
  cwd: string
  /** Where running turns keep their output (one folder each), so a restarted hub can pick them up. */
  turnsDir: string
  turnTimeoutMs: number
  /** After an interrupt, how long before the CLI is killed. */
  killGraceMs?: number
  env?: NodeJS.ProcessEnv
  /** Keys MCP servers need (from Limeade's key store), read at each start so a new key counts at once. */
  keys?: () => Record<string, string>
  /** Folders outside cwd the CLI may read without asking (the uploads folder). */
  addDirs?: readonly string[]
  /**
   * Run Claude Code against another Anthropic-compatible endpoint (LiteLLM, for local models) instead
   * of the user's subscription. Photos then go by path only: most local models can't see images.
   */
  endpoint?: LocalEndpoint
}

/** An Anthropic-style API for local models: LiteLLM, or Ollama itself (which wants its own tag as the model). */
export interface LocalEndpoint {
  url: string
  key: string | null
  /** The endpoint's name for a picker name, when they differ. */
  model?: (name: string) => string
}

/**
 * Environment for a turn on another endpoint: every model slot (main, small/fast, subagents) is the
 * chosen model, so nothing quietly falls back to Claude, and the CLI phones nothing home.
 */
/** The model name the endpoint knows (Ollama's tag for a picker name); the name itself otherwise. */
export function endpointModel(name: string, endpoint: LocalEndpoint | undefined): string {
  return endpoint?.model?.(name) ?? name
}

export function endpointEnv(name: string, endpoint: LocalEndpoint): Record<string, string> {
  const model = endpointModel(name, endpoint)
  return {
    ANTHROPIC_BASE_URL: endpoint.url,
    ANTHROPIC_AUTH_TOKEN: endpoint.key ?? 'none',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

/** Builds the CLI arguments for one turn. Never bypassPermissions. */
export function claudeArgs(
  req: Pick<TurnRequest, 'model' | 'effort' | 'mode' | 'sessionId' | 'agent' | 'appendSystemPrompt'>,
  addDirs: readonly string[] = [],
): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', cliPermissionMode(req.mode),
    '--model', req.model,
    '--effort', req.effort,
    ...(req.agent ? ['--agent', req.agent] : []),
    ...(req.appendSystemPrompt ? ['--append-system-prompt', req.appendSystemPrompt] : []),
    ...(req.sessionId ? ['--resume', req.sessionId] : []),
    ...addDirs.flatMap((d) => ['--add-dir', d]),
  ]
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/**
 * The user message for a turn: small images as image blocks first (Claude sees them at once), then the
 * text with a note naming every file and where it's saved. Plain text when nothing is attached.
 */
export async function userContent(
  prompt: string,
  files: readonly StoredAttachment[] = [],
  read: (path: string) => Promise<Buffer> = (p) => readFile(p),
  inline = true,
): Promise<string | ContentBlock[]> {
  if (!files.length) return prompt
  const blocks: ContentBlock[] = []
  for (const f of files) {
    if (inline && sendsInline(f)) blocks.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: (await read(f.path)).toString('base64') } })
  }
  blocks.push({ type: 'text', text: [prompt.trim(), attachmentNote(files, inline)].filter(Boolean).join('\n\n') })
  return blocks
}

/** "Yes, and don't ask again for …": what the CLI's first suggested rule would allow. */
export function alwaysLabel(suggestions: unknown): string {
  if (!Array.isArray(suggestions)) return ''
  for (const s of suggestions) {
    if (s?.type === 'addRules' && Array.isArray(s.rules) && s.rules[0]) {
      const r = s.rules[0]
      return r.ruleContent ? String(r.ruleContent) : String(r.toolName ?? '')
    }
    if (s?.type === 'addDirectories' && Array.isArray(s.directories)) return `files in ${s.directories.join(', ')}`
    if (s?.type === 'setMode') return `edits (${s.mode})`
  }
  return ''
}

export class ClaudeCli implements TurnEngine, OneShot {
  private o: ClaudeCliOptions
  constructor(o: ClaudeCliOptions) {
    this.o = o
  }

  /** CLIs still winding down after their answer, by session; a resume waits for them (briefly). */
  private closing = new Map<string, Promise<void>>()

  async run(req: TurnRequest): Promise<TurnResult> {
    const prev = req.sessionId ? this.closing.get(req.sessionId) : undefined
    if (prev) await Promise.race([prev, new Promise((r) => setTimeout(r, 15_000))])
    let content: Awaited<ReturnType<typeof userContent>>
    try {
      content = await userContent(req.prompt, req.attachments, undefined, !this.o.endpoint)
    } catch (err) {
      return { text: '', sessionId: req.sessionId, error: `couldn't read an attached file (${(err as Error).message})` }
    }
    return this.startTurn(req, content)
  }

  /**
   * Starts the turn in a keeper process (turn-keeper.ts) that outlives the hub, so a hub restart doesn't
   * end it; the next hub picks it up with reattach().
   */
  private startTurn(req: TurnRequest, content: Awaited<ReturnType<typeof userContent>>): Promise<TurnResult> {
    const handle = randomUUID()
    const dir = join(this.o.turnsDir, handle)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, KEEPER_FILES.first), JSON.stringify({ type: 'user', message: { role: 'user', content } }), { mode: 0o600 })
      writeFileSync(join(dir, STARTED), String(Date.now()), { mode: 0o600 })
    } catch (err) {
      return Promise.resolve({ text: '', sessionId: req.sessionId, error: `couldn't start the turn (${(err as Error).message})` })
    }
    const keeper = spawn(process.execPath, [KEEPER, dir, String(this.o.turnTimeoutMs + 120_000), this.o.bin, ...claudeArgs({ ...req, model: endpointModel(req.model, this.o.endpoint) }, this.o.addDirs)], {
      cwd: req.cwd ?? this.o.cwd,
      env: { ...process.env, ...this.o.keys?.(), ...this.o.env, ...(this.o.endpoint ? endpointEnv(req.model, this.o.endpoint) : {}), ...req.env },
      stdio: 'ignore',
      // Its own process, not tied to the hub: a hub restart leaves it (and the CLI) running.
      detached: true,
    })
    keeper.on('error', (err) => {
      try {
        writeFileSync(join(dir, KEEPER_FILES.exit), JSON.stringify({ code: null, signal: null, error: err.message }), { mode: 0o600 })
      } catch {}
    })
    keeper.unref()
    req.onStart?.(handle)
    return this.follow(dir, req, false).then((r) => r ?? { text: '', sessionId: req.sessionId, error: 'the turn ended without a word' })
  }

  /**
   * Picks up a turn an earlier hub started: everything it said so far comes back as one 'resumed' event,
   * prompts it's still waiting on are asked again, and the rest streams as usual. Null when there's nothing
   * to pick up (the keeper died with the machine, or the turn is unknown).
   */
  async reattach(handle: string, req: TurnRequest): Promise<TurnResult | null> {
    if (!/^[0-9a-f-]{36}$/.test(handle)) return null
    const dir = join(this.o.turnsDir, handle)
    if (!existsSync(join(dir, STARTED))) return null
    return this.follow(dir, req, true)
  }

  /** Old kept turns nobody came back for: a day on, far past any turn's limit, so no keeper still runs. */
  sweep(maxAgeMs = 24 * 3600_000): void {
    let names: string[] = []
    try {
      names = readdirSync(this.o.turnsDir)
    } catch {
      return
    }
    for (const name of names) {
      const dir = join(this.o.turnsDir, name)
      try {
        if (Date.now() - statSync(dir).mtimeMs > Math.max(maxAgeMs, this.o.turnTimeoutMs * 2)) rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }

  /** Reads a kept turn's output from the start and talks to its CLI. Null when the keeper vanished. */
  private follow(dir: string, req: TurnRequest, resumed: boolean): Promise<TurnResult | null> {
    return new Promise((resolve) => {
      const file = (f: string) => join(dir, f)
      let session: string | null = req.sessionId
      let streamed = ''
      let result: { text: string; isError: boolean } | null = null
      let needBreak = false
      let killTimer: NodeJS.Timeout | undefined
      let timedOut = false
      let finished = false
      let live = !resumed
      const replaySteps: Step[] = []
      const waiting: any[] = []
      const answered = resumed ? answeredIds(file(KEEPER_FILES.answered)) : new Set<string>()

      // The way in: the keeper's socket. Lines wait until it's connected.
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
          // Not listening yet (just started): try again. Was connected, or never answers: the keeper is gone.
          if (!wasOpen && Date.now() < connectBy && !existsSync(file(KEEPER_FILES.exit))) setTimeout(connect, 50)
          else sockGone = true
        })
      }
      connect()

      const stopNow = () => {
        // Ask politely first (the CLI saves the session), then make sure.
        write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
        killTimer = setTimeout(() => write({ keeper: 'kill' }), this.o.killGraceMs ?? 5_000)
      }
      const startedAt = Number(readText(file(STARTED))) || Date.now()
      const timer = setTimeout(() => {
        timedOut = true
        stopNow()
      }, Math.max(0, startedAt + this.o.turnTimeoutMs - Date.now()))
      req.signal.addEventListener('abort', stopNow, { once: true })

      const onLine = (line: string) => {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.session_id) session = msg.session_id
        // Which Claude version an alias is (for the picker); a local model's name says nothing about that.
        if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.model === 'string' && !this.o.endpoint) {
          req.onEvent({ type: 'model', alias: req.model, modelId: msg.model })
        } else if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
          const ev = msg.event
          if (ev?.type === 'message_start' && streamed) needBreak = true
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            const text = (needBreak ? '\n\n' : '') + ev.delta.text
            needBreak = false
            streamed += text
            if (live) req.onEvent({ type: 'text', text })
          }
        } else if (msg.type === 'assistant' && !msg.parent_tool_use_id && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type !== 'tool_use') continue
            const step = stepFor(block.name, block.input)
            if (live) req.onEvent({ type: 'step', step })
            else replaySteps.push(step)
          }
        } else if (msg.type === 'control_request') {
          if (live) this.answerControl(msg, req, write)
          else if (!answered.has(msg.request_id)) waiting.push(msg)
        } else if (msg.type === 'result') {
          result = { text: typeof msg.result === 'string' ? msg.result : '', isError: Boolean(msg.is_error) }
          write({ keeper: 'end-stdin' })
        }
      }

      // The way out: out.jsonl, read from the start, then as it grows.
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
      const tick = () => {
        if (finished) return
        readMore()
        if (!live) {
          // Caught up with what the earlier hub missed: show it, ask what's still open, then stream.
          live = true
          req.onEvent({ type: 'resumed', text: streamed, steps: replaySteps })
          for (const msg of waiting) this.answerControl(msg, req, write)
        }
        if (result) return finish(null, false)
        const exit = readJson(file(KEEPER_FILES.exit))
        if (exit) {
          readMore()
          return finish(exit, false)
        }
        // The keeper is gone without saying how the CLI ended: the box went down under it.
        if (sockGone) {
          goneAt ||= Date.now()
          if (Date.now() - goneAt > 1_000) return finish(null, true)
        }
      }
      let poll: NodeJS.Timeout | undefined

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
        const r = result as { text: string; isError: boolean } | null
        if (r && !r.isError) return resolve({ text: r.text || streamed, sessionId: session })
        if (timedOut) {
          const mins = Math.round(this.o.turnTimeoutMs / 60_000)
          return resolve({ text: streamed, sessionId: session, error: `it ran for more than ${mins} min, so it was stopped` })
        }
        if (req.signal.aborted) return resolve({ text: streamed, sessionId: session })
        if (vanished && !r) return resolve(null)
        const stderr = readText(file(KEEPER_FILES.err))
        const sessionLost = /no conversation found|session .* not found/i.test(stderr)
        const why = exit?.error || (exit?.signal === 'SIGTERM' ? 'timed out' : lastLine(stderr) || (r?.text ?? '') || `exit ${exit?.code ?? '?'}`)
        resolve({ text: r?.isError ? streamed : r?.text || streamed, sessionId: sessionLost ? null : session, error: why, sessionLost })
      }

      try {
        watcher = watch(dir, () => tick())
        watcher.on('error', () => {})
      } catch {}
      poll = setInterval(tick, 250)
      tick()
    })
  }

  /**
   * The turn's result is in. The CLI may still be saving its session and closing MCP servers; a resume
   * of that session waits for it (briefly). The folder goes once the CLI has exited.
   */
  private tidy(dir: string, session: string | null) {
    const exitFile = join(dir, KEEPER_FILES.exit)
    if (existsSync(exitFile)) return rmSync(dir, { recursive: true, force: true })
    try {
      writeFileSync(join(dir, KEEPER_FILES.collected), '', { mode: 0o600 })
    } catch {}
    // The keeper may have exited between the two checks.
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

  /** One reply, no tools, no MCP servers, nothing saved (same as Toolbox's own drafting). */
  complete(req: Parameters<OneShot['complete']>[0]): Promise<string> {
    const args = [
      '-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '',
      '--output-format', 'json', '--model', req.model, '--effort', req.effort, '--system-prompt', req.system,
    ]
    return new Promise((resolve, reject) => {
      const child = spawn(this.o.bin, args, { cwd: '/tmp', env: { ...process.env, ...this.o.env }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill('SIGTERM'), 240_000)
      child.stdout.on('data', (d: Buffer) => (out += d))
      child.stderr.on('data', (d: Buffer) => (err = (err + d).slice(-2000)))
      child.on('error', reject)
      child.on('close', () => {
        clearTimeout(timer)
        try {
          const j = JSON.parse(out)
          if (j.is_error) return reject(new Error(String(j.result || 'Claude could not do that')))
          resolve(String(j.result ?? ''))
        } catch {
          reject(new Error(lastLine(err) || 'Claude did not answer'))
        }
      })
      child.stdin.on('error', () => {})
      child.stdin.end(req.prompt)
    })
  }

  private answerControl(msg: any, req: TurnRequest, write: (o: unknown) => void) {
    const reply = (response: unknown) =>
      write({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } })
    const r = msg.request
    if (r?.subtype !== 'can_use_tool') {
      write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'Not supported by the hub' } })
      return
    }
    const step = stepFor(r.tool_name, r.input)
    req.onEvent({
      type: 'approval',
      request: {
        tool: step.tool,
        text: step.text,
        description: String(r.description ?? ''),
        alwaysLabel: alwaysLabel(r.permission_suggestions),
      },
      answer: (decision: ApprovalDecision, message?: string) => {
        if (decision === 'no') {
          return reply({ behavior: 'deny', message: message || 'The user said no.', interrupt: !message })
        }
        reply({
          behavior: 'allow',
          updatedInput: r.input,
          ...(decision === 'always' && Array.isArray(r.permission_suggestions) ? { updatedPermissions: r.permission_suggestions } : {}),
        })
      },
    })
  }
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
      ids.add(JSON.parse(line).id)
    } catch {}
  }
  return ids
}

function lastLine(s: string): string {
  return s.trim().split('\n').at(-1)?.slice(0, 300) ?? ''
}
