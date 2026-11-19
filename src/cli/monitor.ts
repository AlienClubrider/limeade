// `limeade monitor`: the Assistant's command for monitors (recurring, unattended agent jobs), through the
// hub's API ($LIMEADE_HUB, default http://127.0.0.1:8797; key in $LIMEADE_CONFIG/key).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const USAGE = `limeade monitor: recurring agent jobs
  limeade monitor list
  limeade monitor show <id>
  limeade monitor log <id> [run-id]          (the newest run when no run is given)
  limeade monitor add "<name>" --when "<schedule>" (--file <instructions-file> | --text "<instructions>")
                      [--description "<one line on what it does>"] [--agent <name>] [--folder <dir>] [--paused]
  limeade monitor add "<name>" --check "<command>" [--every "10 min"] (--file … | --text …) [--agent …] [--folder …]
  limeade monitor edit <id> [--name …] [--when … | --check … --every …] [--file … | --text …] [--description …] [--agent <name|->] [--folder …]
  limeade monitor pause <id> | resume <id> | run <id> | rm <id>
Schedules: "every 30 min", "every 2 hours", "daily 21:00", "weekdays 07:30", "mon,wed,fri 9am".
A check runs its command every N minutes; the job runs when the command's output changes.`

const env = process.env

function fail(msg: string, code = 2): never {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
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

/** "--when x --agent y" -> { when: 'x', agent: 'y' }; bare words stay in order. */
export function parseArgs(args: string[]): { words: string[]; flags: Record<string, string> } {
  const words: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--paused') flags.paused = '1'
    else if (a.startsWith('--')) {
      if (i + 1 >= args.length) fail(`${a} needs a value`)
      flags[a.slice(2)] = args[++i]!
    } else words.push(a)
  }
  return { words, flags }
}

/** The fields a create or edit sends, from the flags. */
export function bodyFrom(flags: Record<string, string>, read: (path: string) => string = (p) => readFileSync(p === '-' ? 0 : p, 'utf8')): Record<string, unknown> {
  const b: Record<string, unknown> = {}
  if (flags.name !== undefined) b.name = flags.name
  if (flags.description !== undefined) b.description = flags.description
  if (flags.when !== undefined) b.trigger = { kind: 'schedule', text: flags.when }
  if (flags.check !== undefined) b.trigger = { kind: 'check', command: flags.check, ...(flags.every ? { every: flags.every } : {}) }
  if (flags.file !== undefined) b.instructions = read(flags.file)
  if (flags.text !== undefined) b.instructions = flags.text
  if (flags.agent !== undefined) b.agent = flags.agent === '-' ? null : flags.agent
  if (flags.folder !== undefined) b.cwd = resolve(flags.folder.replace(/^~(?=\/|$)/, homedir()))
  if (flags.paused) b.enabled = false
  return b
}

function ago(iso: string | null | undefined): string {
  if (!iso) return ''
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  const a = Math.abs(s)
  const t = a < 90 ? `${a}s` : a < 5400 ? `${Math.round(a / 60)}m` : a < 172800 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`
  return s >= 0 ? `${t} ago` : `in ${t}`
}

function runLine(r: any): string {
  return `${r.id}  ${r.status.padEnd(9)} ${new Date(r.startedAt).toLocaleString()}  ${r.summary}`
}

/** An id, or a monitor's name. */
async function idOf(word: string | undefined): Promise<string> {
  if (!word) fail(USAGE)
  const all: any[] = await hub('GET', '/monitors')
  const m = all.find((x) => x.id === word) ?? all.find((x) => x.name.toLowerCase() === word.toLowerCase())
  if (!m) fail(`no monitor "${word}" (limeade monitor list)`, 1)
  return m.id
}

async function main(argv: string[]) {
  const [cmd = 'help', ...rest] = argv
  const { words, flags } = parseArgs(rest)
  const say = (s: string) => process.stdout.write(`${s}\n`)
  switch (cmd) {
    case 'list':
    case 'ls': {
      const all: any[] = await hub('GET', '/monitors')
      if (!all.length) return say('No monitors yet.')
      for (const m of all) {
        const last = m.lastRun ? `last: ${m.lastRun.status} ${ago(m.lastRun.startedAt)} — ${m.lastRun.summary}` : 'never run'
        say(`${m.id}  ${m.enabled ? '' : '[paused] '}${m.name} · ${m.trigger.text}${m.agent ? ` · as ${m.agent}` : ''}${m.description ? `\n    ${m.description}` : ''}\n    next: ${m.nextRunAt ? ago(m.nextRunAt) : '-'} · ${last}`)
      }
      return
    }
    case 'show': {
      const m = await hub('GET', `/monitors/${encodeURIComponent(await idOf(words[0]))}`)
      say(`${m.name} (${m.id})${m.enabled ? '' : ' [paused]'}${m.description ? `\n${m.description}` : ''}\nWhen: ${m.trigger.text}\nAgent: ${m.agent ?? '-'}\nFolder: ${m.cwd}\nNext: ${m.nextRunAt ?? '-'}\n\n${m.instructions}\n\nRuns:`)
      for (const r of m.runs.slice(0, 10)) say(`  ${runLine(r)}`)
      if (!m.runs.length) say('  (none yet)')
      return
    }
    case 'log': {
      const id = await idOf(words[0])
      const runId = words[1] ?? (await hub('GET', `/monitors/${encodeURIComponent(id)}`)).runs[0]?.id
      if (!runId) fail('it has no runs yet', 1)
      const r = await hub('GET', `/monitors/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`)
      say(`${runLine(r)}\n\n${r.log}`)
      return
    }
    case 'add': {
      if (!words[0]) fail(USAGE)
      if (!flags.when && !flags.check) fail('say when: --when "<schedule>" or --check "<command>"')
      if (!flags.file && !flags.text) fail('give the instructions: --file <file> or --text "<instructions>"')
      const m = await hub('POST', '/monitors', { ...bodyFrom(flags), name: words[0] })
      say(`added ${m.id}: ${m.trigger.text}${m.nextRunAt ? `, next ${ago(m.nextRunAt)}` : ' (paused)'}`)
      return
    }
    case 'edit': {
      const body = bodyFrom(flags)
      if (!Object.keys(body).length) fail(USAGE)
      const m = await hub('PATCH', `/monitors/${encodeURIComponent(await idOf(words[0]))}`, body)
      say(`changed ${m.id}: ${m.trigger.text}`)
      return
    }
    case 'pause':
    case 'resume': {
      const m = await hub('PATCH', `/monitors/${encodeURIComponent(await idOf(words[0]))}`, { enabled: cmd === 'resume' })
      say(cmd === 'pause' ? `paused ${m.id}` : `resumed ${m.id}, next ${ago(m.nextRunAt)}`)
      return
    }
    case 'run': {
      const id = await idOf(words[0])
      const r = await hub('POST', `/monitors/${encodeURIComponent(id)}/run`)
      say(`running ${id} (run ${r.id}); see: limeade monitor log ${id} ${r.id}`)
      return
    }
    case 'rm':
    case 'delete': {
      const id = await idOf(words[0])
      await hub('DELETE', `/monitors/${encodeURIComponent(id)}`)
      say(`deleted ${id}`)
      return
    }
    default:
      say(USAGE)
      if (cmd !== 'help' && cmd !== '--help') process.exit(2)
  }
}

if (import.meta.main) await main(process.argv.slice(2))
