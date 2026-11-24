// `limeade claude-sign-in`: whether Claude's sign-in and background token work, a check now, or a report
// from a worker script or another app that something failed on them (one bell item, a sign-in link).

import { hub } from './monitor.ts'

const USAGE = `limeade claude-sign-in: is Claude's sign-in working?
  limeade claude-sign-in                       what Limeade last saw
  limeade claude-sign-in check                 check both now
  limeade claude-sign-in failed "<what>" [--token]
      something failed with an auth error (e.g. a worker); --token: it ran on the background token`

const say = (line: string) => process.stdout.write(`${line}\n`)

function show(v: any) {
  const word = (s: string) => (s === 'ok' ? 'OK' : s === 'needs-you' ? 'needs you' : s === 'none' ? 'not set up' : 'not checked yet')
  say(`sign-in: ${word(v.login.state)}${v.login.checkedAt ? ` (checked ${v.login.checkedAt})` : ''}`)
  say(`background token: ${word(v.token.state)}${v.token.endsOn ? `, runs out about ${v.token.endsOn}` : ''}`)
  for (const f of [...v.login.failed, ...v.token.failed]) say(`  stopped: ${f}`)
}

export async function main(args: string[]): Promise<void> {
  const [cmd, ...rest] = args
  if (!cmd) return show(await hub('GET', '/claude-health'))
  if (cmd === 'check') return show(await hub('POST', '/claude-health/check'))
  if (cmd === 'failed') {
    const what = rest.filter((a) => a !== '--token').join(' ').trim()
    if (!what) {
      say(USAGE)
      process.exit(2)
    }
    return show(await hub('POST', '/claude-health/failed', { what, credential: rest.includes('--token') ? 'token' : 'login' }))
  }
  say(USAGE)
  if (cmd !== 'help' && cmd !== '--help') process.exit(2)
}

if (import.meta.main) await main(process.argv.slice(2))
