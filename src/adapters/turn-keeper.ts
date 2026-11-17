// Keeps one Claude Code turn running when the hub restarts. The hub starts this as its own detached
// process (the unit's KillMode=process leaves it alone on a restart); it runs the CLI and keeps its
// pipes, so the CLI never sees the hub go. Everything the CLI says goes to out.jsonl in the turn's
// folder, where any hub (the one that started it, or the next one) reads it from the start. The hub
// writes to the CLI through in.sock, one JSON line at a time.
//
//   node turn-keeper.ts <turn folder> <max ms> <bin> [args…]
//
// Files in the turn folder (all 0600, the folder 0700):
//   first.json     the turn's first user message, written by the hub before it starts this (deleted once sent)
//   out.jsonl      the CLI's stdout, line by line
//   answered.jsonl request ids of the permission prompts the hub has answered (so a new hub doesn't ask again)
//   err.log        the end of the CLI's stderr
//   exit.json      {code, signal, error?} once the CLI has exited
//   collected      the hub has taken the result; the folder goes when the CLI exits

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { KEEPER_FILES } from './turn-files.ts'

const [dir, maxMsArg, bin, ...args] = process.argv.slice(2)
if (!dir || !bin) {
  console.error('usage: turn-keeper.ts <turn folder> <max ms> <bin> [args…]')
  process.exit(2)
}
const path = (f: string) => join(dir, f)
const out = openSync(path(KEEPER_FILES.out), 'a', 0o600)
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

// The CLI's own lines, one per line. After its answer the CLI still saves its session and closes its
// MCP servers; if that hangs, it's ended a minute later.
createInterface({ input: child.stdout }).on('line', (line) => {
  writeSync(out, line + '\n')
  try {
    if (JSON.parse(line)?.type === 'result') setTimeout(killAll, 60_000).unref()
  } catch {}
})

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
    if (msg?.keeper === 'end-stdin') return void child.stdin.end()
    if (child.stdin.writable) child.stdin.write(line + '\n')
    if (msg?.type === 'control_response' && msg.response?.request_id) {
      appendFileSync(path(KEEPER_FILES.answered), JSON.stringify({ id: msg.response.request_id }) + '\n', { mode: 0o600 })
    }
  })
  sock.on('error', () => {})
})
server.listen(path(KEEPER_FILES.socket))

try {
  child.stdin.write(readFileSync(path(KEEPER_FILES.first), 'utf8').trim() + '\n')
  unlinkSync(path(KEEPER_FILES.first))
} catch {}

const done = (r: { code: number | null; signal: string | null; error?: string }) => {
  if (exited) return
  exited = true
  writeFileSync(path(KEEPER_FILES.err), stderr, { mode: 0o600 })
  writeFileSync(path(KEEPER_FILES.exit), JSON.stringify(r), { mode: 0o600 })
  server.close()
  // The hub already has what it needs: tidy up. Otherwise the next hub reads exit.json and tidies.
  if (existsSync(path(KEEPER_FILES.collected))) rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
child.on('error', (err) => done({ code: null, signal: null, error: err.message }))
// Something the CLI started may hold its stdout open after the CLI itself exits: don't wait for it long.
child.on('exit', (code, signal) => setTimeout(() => done({ code, signal }), 2_000).unref())
child.on('close', (code, signal) => done({ code, signal }))
