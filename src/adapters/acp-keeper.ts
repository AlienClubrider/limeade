// Keeps one agent turn running through ACP (the Agent Client Protocol) when the hub restarts, like
// turn-keeper.ts does for the Claude Code CLI. The hub starts this as its own detached process; it runs
// the ACP adapter (claude-agent-acp or codex-acp), opens or resumes the session, sends the prompt and keeps the pipes,
// so the adapter never sees the hub go. Everything the adapter says goes to out.jsonl, where any hub
// reads it from the start. The hub writes to it through in.sock, one JSON line at a time.
//
//   node acp-keeper.ts <turn folder> <max ms> <bin> [args…]
//
// Files in the turn folder are turn-keeper.ts's (KEEPER_FILES). first.json holds the turn (AcpTurnSpec).
// Besides the adapter's own JSON-RPC lines, out.jsonl gets the keeper's: {keeper:'session', sessionId},
// then {keeper:'done', stopReason} or {keeper:'error', stage, code?, message}.
//
// What the hub may write to in.sock:
//   a JSON-RPC response    the answer to one of the adapter's requests (a permission prompt)
//   {keeper:'cancel'}      stop the turn politely (session/cancel)
//   {keeper:'steer', text} tell the agent something mid-turn (after a refused tool, the reason)
//   {keeper:'steer', id, prompt}  his message for the running turn (ACP content blocks); out.jsonl gets
//                          {keeper:true, steered: id, outcome} ('injected' when the agent took it in)
//   {keeper:'kill'}        stop it now

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { KEEPER_FILES } from './turn-files.ts'

/** The turn the hub hands the keeper in first.json. */
export interface AcpTurnSpec {
  /** The agent's session to resume, or null for a new one. */
  sessionId: string | null
  /** session/new (or session/resume) params, without sessionId. */
  session: { cwd: string; mcpServers: unknown[]; additionalDirectories?: string[]; systemPrompt?: unknown; _meta?: unknown }
  /** ACP session mode id (Claude: default, acceptEdits, auto, plan; Codex: read-only, workspace-write, agent). */
  modeId: string
  /** Session config options set after the mode (Codex's collaboration_mode). */
  config?: { configId: string; value: string }[]
  /** ACP content blocks. */
  prompt: unknown[]
}

const [dir, maxMsArg, bin, ...args] = process.argv.slice(2)
if (!dir || !bin) {
  console.error('usage: acp-keeper.ts <turn folder> <max ms> <bin> [args…]')
  process.exit(2)
}
const path = (f: string) => join(dir, f)
const out = openSync(path(KEEPER_FILES.out), 'a', 0o600)
const note = (o: Record<string, unknown>) => writeSync(out, JSON.stringify({ keeper: true, ...o }) + '\n')
let stderr = ''
let exited = false

const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
const killAll = () => {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  setTimeout(() => {
    try {
      if (child.pid && !exited) process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 5_000).unref()
}
child.stdin.on('error', () => {})
child.stderr.on('data', (d: Buffer) => {
  stderr = (stderr + d.toString()).slice(-4000)
})
const send = (o: unknown) => {
  if (child.stdin.writable) child.stdin.write(JSON.stringify(o) + '\n')
}

// The keeper's own requests: ids "keeper-n", so they never meet the hub's answers to the adapter's requests.
let nextId = 0
const waiting = new Map<string, { resolve: (r: any) => void; reject: (e: { code?: number; message: string }) => void }>()
const request = (method: string, params: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = `keeper-${++nextId}`
    waiting.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })

createInterface({ input: child.stdout }).on('line', (line) => {
  writeSync(out, line + '\n')
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const w = typeof msg?.id === 'string' && !msg.method ? waiting.get(msg.id) : undefined
  if (!w) return
  waiting.delete(msg.id)
  if (msg.error) w.reject({ code: msg.error.code, message: String(msg.error.data?.details ?? msg.error.message ?? 'error') })
  else w.resolve(msg.result)
})

let sessionId: string | null = null
let cancelled = false
let finished = false

const finishTurn = (o: Record<string, unknown>) => {
  if (finished) return
  finished = true
  note(o)
  // The adapter has saved the session as it went; let it close, and make sure a minute on.
  child.stdin.end()
  setTimeout(killAll, 60_000).unref()
}

async function runTurn(spec: AcpTurnSpec) {
  let stage = 'initialize'
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // Advisory notices come as their own updates, not as text in Claude's reply (the CLI path doesn't show them).
        session: { notices: {} },
      },
    })
    stage = spec.sessionId ? 'resume' : 'new'
    const opened = spec.sessionId
      ? await request('session/resume', { ...spec.session, sessionId: spec.sessionId })
      : await request('session/new', spec.session)
    sessionId = spec.sessionId ?? String(opened?.sessionId ?? '')
    note({ sessionId })
    // Never run in a mode the hub didn't ask for (the session may remember another): stop if it can't be set.
    stage = 'mode'
    await request('session/set_mode', { sessionId, modeId: spec.modeId })
    for (const c of spec.config ?? []) await request('session/set_config_option', { sessionId, configId: c.configId, value: c.value })
    if (cancelled) return finishTurn({ stopReason: 'cancelled' })
    stage = 'prompt'
    const r = await request('session/prompt', { sessionId, prompt: spec.prompt })
    finishTurn({ stopReason: String(r?.stopReason ?? 'end_turn') })
  } catch (err) {
    const e = err as { code?: number; message?: string }
    finishTurn({ error: e.message ?? String(err), stage, ...(typeof e.code === 'number' ? { code: e.code } : {}) })
  }
}

// Never longer than the hub's own limit (plus a little): a turn whose hub never came back still ends.
const maxMs = Number(maxMsArg) || 30 * 60_000
setTimeout(killAll, maxMs).unref()

const server = createServer((sock) => {
  createInterface({ input: sock }).on('line', (line) => {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg?.keeper === 'kill') return killAll()
    if (msg?.keeper === 'cancel') {
      cancelled = true
      if (sessionId) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
      return
    }
    if (msg?.keeper === 'steer' && typeof msg.id === 'string') {
      const id = msg.id
      // Only into a turn that's running: otherwise the hub sends it as a turn of its own.
      if (!sessionId || finished || !Array.isArray(msg.prompt)) return void note({ steered: id, outcome: 'notRunning' })
      const params = { sessionId, prompt: msg.prompt, _meta: { steering: { idleBehavior: 'promptRequired' } } }
      void request('_session/steering', params).then(
        (r) => note({ steered: id, outcome: String(r?.outcome ?? 'failed') }),
        (e) => note({ steered: id, outcome: 'failed', why: String(e?.message ?? e) }),
      )
      return
    }
    if (msg?.keeper === 'steer') {
      if (sessionId && typeof msg.text === 'string' && msg.text) {
        const params = { sessionId, prompt: [{ type: 'text', text: msg.text }], _meta: { steering: { idleBehavior: 'promptRequired' } } }
        void request('_session/steering', params).catch(() => {})
      }
      return
    }
    // An answer to one of the adapter's requests.
    if (msg?.jsonrpc === '2.0' && 'id' in msg && !msg.method) {
      send(msg)
      appendFileSync(path(KEEPER_FILES.answered), JSON.stringify({ id: msg.id }) + '\n', { mode: 0o600 })
    }
  })
  sock.on('error', () => {})
})
server.listen(path(KEEPER_FILES.socket))

try {
  const spec = JSON.parse(readFileSync(path(KEEPER_FILES.first), 'utf8')) as AcpTurnSpec
  unlinkSync(path(KEEPER_FILES.first))
  void runTurn(spec)
} catch (err) {
  finishTurn({ error: `couldn't read the turn (${(err as Error).message})`, stage: 'start' })
}

const done = (r: { code: number | null; signal: string | null; error?: string }) => {
  if (exited) return
  exited = true
  if (!finished) note({ error: r.error ?? (lastLine(stderr) || `the ACP adapter ended (exit ${r.code ?? r.signal ?? '?'})`), stage: 'exit' })
  writeFileSync(path(KEEPER_FILES.err), stderr, { mode: 0o600 })
  writeFileSync(path(KEEPER_FILES.exit), JSON.stringify(r), { mode: 0o600 })
  server.close()
  // The hub already has what it needs: tidy up. Otherwise the next hub reads exit.json and tidies.
  if (existsSync(path(KEEPER_FILES.collected))) rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
child.on('error', (err) => done({ code: null, signal: null, error: err.message }))
// Something the adapter started may hold its stdout open after it exits: don't wait for it long.
child.on('exit', (code, signal) => setTimeout(() => done({ code, signal }), 2_000).unref())
child.on('close', (code, signal) => done({ code, signal }))

function lastLine(s: string): string {
  return s.trim().split('\n').at(-1)?.slice(0, 300) ?? ''
}
