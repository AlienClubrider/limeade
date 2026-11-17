// `fleet`: the Assistant's and its workers' command for worker records, bundled with Limeade (built-in
// workers). Same files and wording as the fleet scripts some servers have, in $FLEET_HOME:
//   status/<name>.status  one line per report: "<UTC time> <state>: <text>"
//   backlog.tsv           jobs: id state session title note updated
//   events.log            what the hub noticed: "<seq> <UTC time> <name> <kind>: <text>"
//   cursor                the last event the Assistant handled
//   notes.md              short notes for the next Assistant
// Starting, answering and stopping workers goes through the hub ($LIMEADE_HUB, key in $LIMEADE_CONFIG/key).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseEventLine } from '../domain/fleet.ts'

const USAGE = `fleet: workers and their records
  Workers:    fleet status <working|paused|needs-decision|blocked|done|failed> "<one line>"
  Assistant:  fleet start <agent|-> "<Title>" <folder> <brief-file> [--model <id>] [--on claude|codex]
              fleet list | show <name> | send <name> "<text>" | stop <name>
              fleet digest | events [--all] | ack [seq]
              fleet task add "<title>" [state] [session] [note] | task set <id> state=… note=… | task list`

const STATES = ['working', 'paused', 'needs-decision', 'blocked', 'done', 'failed']
const env = process.env
const F = env.FLEET_HOME || join(homedir(), '.local/state/limeade/fleet')
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const rows = (p: string) => read(p).split('\n').filter(Boolean)
const BACKLOG = join(F, 'backlog.tsv')

function fail(msg: string, code = 2): never {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

function writeRows(p: string, lines: string[]) {
  writeFileSync(`${p}.tmp`, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 })
  renameSync(`${p}.tmp`, p)
}

/** "5m", "3h", "2d" ago. */
function age(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 3600 ? `${Math.floor(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

async function hub(method: string, path: string, body?: unknown): Promise<any> {
  const base = env.LIMEADE_HUB || 'http://127.0.0.1:8797'
  const keyFile = join(env.LIMEADE_CONFIG || join(homedir(), '.config/limeade'), 'key')
  let key = ''
  try {
    key = readFileSync(keyFile, 'utf8').trim()
  } catch {
    fail(`can't read Limeade's key (${keyFile})`, 1)
  }
  let r: Response
  try {
    r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    fail(`Limeade isn't answering at ${base} (${(err as Error).message})`, 1)
  }
  const out: any = await r.json().catch(() => ({}))
  if (!r.ok) fail(out?.error ?? `Limeade said ${r.status}`, 1)
  return out
}

function unread(all = false): string[] {
  const cursor = all ? 0 : Number.parseInt(read(join(F, 'cursor')).trim(), 10) || 0
  return rows(join(F, 'events.log')).filter((l) => (parseEventLine(l)?.seq ?? 0) > cursor)
}

async function main(argv: string[]) {
  mkdirSync(join(F, 'status'), { recursive: true, mode: 0o700 })
  const [cmd = 'help', ...a] = argv
  switch (cmd) {
    case 'status': {
      const [st = '', ...words] = a
      const text = words.join(' ').replace(/\s+/g, ' ').trim()
      if (!STATES.includes(st)) fail(`state must be one of: ${STATES.join(' ')}`)
      if (!text) fail('usage: fleet status <state> "<one line>"')
      const slug = env.FLEET_SLUG
      if (!slug || !/^[a-z0-9-]{1,64}$/.test(slug)) return console.log('not a fleet session (no FLEET_SLUG); nothing recorded')
      appendFileSync(join(F, 'status', `${slug}.status`), `${now()} ${st}: ${text}\n`, { mode: 0o600 })
      return console.log(`recorded for ${slug}`)
    }
    case 'task': {
      const [sub = 'list', ...t] = a
      const lines = rows(BACKLOG)
      if (sub === 'add') {
        const [title, st = 'queued', sess = '-', note = '-'] = t
        if (!title) fail('usage: fleet task add "<title>" [state] [session] [note]')
        const id = Math.max(0, ...lines.map((l) => Number(l.split('\t')[0]) || 0)) + 1
        const clean = (v: string) => v.replace(/[\t\n]/g, ' ')
        appendFileSync(BACKLOG, `${[id, st, sess, title, note].map((v) => clean(String(v))).join('\t')}\t${now()}\n`, { mode: 0o600 })
        return console.log(`task ${id} added`)
      }
      if (sub === 'set') {
        const [id, ...kvs] = t
        const col: Record<string, number> = { state: 1, session: 2, title: 3, note: 4 }
        let next = lines.map((l) => l.split('\t'))
        for (const kv of kvs) {
          const k = kv.slice(0, kv.indexOf('='))
          const v = kv.slice(kv.indexOf('=') + 1).replace(/[\t\n]/g, ' ')
          if (!(k in col)) fail(`unknown field ${k}`)
          next = next.map((f) => (f[0] === id ? Object.assign([...f], { [col[k]!]: v, 5: now() }) : f))
        }
        // Keep only the 20 newest done jobs.
        const done = next.filter((f) => f[1] === 'done').sort((x, y) => String(x[5]).localeCompare(String(y[5]))).slice(-20)
        const kept = [...next.filter((f) => f[1] !== 'done'), ...done].sort((x, y) => Number(x[0]) - Number(y[0]))
        writeRows(BACKLOG, kept.map((f) => f.join('\t')))
        return console.log(`task ${id} updated`)
      }
      if (sub === 'list') {
        for (const l of lines) {
          const f = l.split('\t')
          console.log(`#${f[0]} ${(f[1] ?? '').padEnd(7)} ${f[3]} | session: ${f[2]} | ${f[4]} | ${f[5]}`)
        }
        return
      }
      return fail('fleet task add|set|list')
    }
    case 'events':
      return unread(a[0] === '--all').forEach((l) => console.log(l))
    case 'ack': {
      const s = a[0] ?? String(parseEventLine(rows(join(F, 'events.log')).at(-1) ?? '')?.seq ?? 0)
      writeFileSync(join(F, 'cursor'), `${Number.parseInt(s, 10) || 0}\n`, { mode: 0o600 })
      return console.log(`acked through ${Number.parseInt(s, 10) || 0}`)
    }
    case 'start': {
      const opts: Record<string, string> = {}
      const pos: string[] = []
      for (let i = 0; i < a.length; i++) {
        if (a[i] === '--model' || a[i] === '--on') opts[a[i]!.slice(2)] = a[++i] ?? ''
        else pos.push(a[i]!)
      }
      const [persona, title, folder, briefFile] = pos
      if (!persona || !title || !folder || !briefFile) fail('usage: fleet start <agent|-> "<Title>" <folder> <brief-file> [--model <id>] [--on claude|codex]')
      if (!existsSync(briefFile)) fail(`no brief file: ${briefFile}`, 1)
      const w = await hub('POST', '/workers', {
        persona, title, folder: resolve(folder), brief: readFileSync(briefFile, 'utf8'),
        ...(opts.model ? { model: opts.model } : {}), ...(opts.on ? { agent: opts.on } : {}),
      })
      return console.log(`started ${w.id} (${w.model}${w.agent ? `, as ${w.agent}` : ''}) in ${w.dir}`)
    }
    case 'list': {
      const { workers } = await hub('GET', '/workers')
      if (!workers.length) return console.log('no workers')
      for (const w of workers) console.log(`${w.id}  ${w.state}  ${w.title}: ${w.now}${w.at ? ` (${age(w.at)} ago)` : ''}`)
      return
    }
    case 'show': {
      if (!a[0]) fail('usage: fleet show <name>')
      const w = await hub('GET', `/workers/${encodeURIComponent(a[0])}`)
      console.log(`${w.title} (${w.id}): ${w.state}, ${w.model}${w.agent ? ` as ${w.agent}` : ''}, in ${w.dir}`)
      for (const l of w.lines ?? []) console.log(`  ${l.at} ${l.state}: ${l.text}`)
      if (w.reply) console.log(`\nLast reply:\n${w.reply.length > 4000 ? `…${w.reply.slice(-4000)}` : w.reply}`)
      return
    }
    case 'send': {
      const [name, ...words] = a
      if (!name || !words.length) fail('usage: fleet send <name> "<text>"')
      await hub('POST', `/workers/${encodeURIComponent(name)}/messages`, { text: words.join(' ') })
      return console.log(`sent to ${name}`)
    }
    case 'stop': {
      if (!a[0]) fail('usage: fleet stop <name>')
      await hub('POST', `/workers/${encodeURIComponent(a[0])}/stop`)
      return console.log(`stopped ${a[0]}`)
    }
    case 'digest': {
      console.log(`# Fleet digest ${now()}\n\n## Workers`)
      const { workers } = await hub('GET', '/workers')
      if (!workers.length) console.log('- none')
      for (const w of workers) console.log(`- ${w.title} (${w.id}, ${w.state}): ${w.at ? `${w.now} (${age(w.at)} ago)` : 'no status yet'}`)
      const tasks = rows(BACKLOG).map((l) => l.split('\t'))
      for (const [st, head] of [['waiting', 'Waiting on the user'], ['running', 'In progress'], ['queued', 'Not started']] as const) {
        console.log(`\n## ${head}`)
        const these = tasks.filter((f) => f[1] === st)
        if (!these.length) console.log('- none')
        for (const f of these) console.log(`- #${f[0]} ${f[3]}${f[2] && f[2] !== '-' ? ` [${f[2]}]` : ''}${f[4] && f[4] !== '-' ? ` (${f[4]})` : ''}`)
      }
      console.log('\n## Recently done')
      const done = tasks.filter((f) => f[1] === 'done').sort((x, y) => String(x[5]).localeCompare(String(y[5]))).slice(-5)
      console.log(done.length ? done.map((f) => `- #${f[0]} ${f[3]}`).join('\n') : '- none')
      console.log('\n## Unread events')
      const ev = unread()
      console.log(ev.length ? ev.join('\n') : '- none')
      console.log('\n## Notes')
      const notes = read(join(F, 'notes.md')).trim()
      return console.log(notes || '- none')
    }
    default:
      return console.log(USAGE)
  }
}

await main(process.argv.slice(2))
