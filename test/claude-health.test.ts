import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  START, alertText, failed, isAuthFailure, probed, readTokenFile, setupTokenFrom, tokenDaysLeft, tokenEndsOn, tokenFileText,
  type ProbeOutcome,
} from '../src/domain/claude-health.ts'
import { signInLink } from '../src/domain/agent-setup.ts'
import { ClaudeHealth } from '../src/app/claude-health.ts'
import { ClaudeTokenFile } from '../src/adapters/claude-token-file.ts'
import { ClaudeProbe } from '../src/adapters/claude-probe.ts'
import { CliSignIn, signInCommand } from '../src/adapters/agent-sign-in.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'claude-health-'))
const AT = '2026-11-24T10:00:00.000Z'
const FAKE_TOKEN = `sk-ant-oat01-${'A'.repeat(40)}_b-c`

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// ---------- rules ----------

test('auth failures are told apart from other errors', () => {
  for (const s of [
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
    'Authentication required',
    'Invalid API key · Please run /login',
    'OAuth token has expired',
  ]) assert.ok(isAuthFailure(s), s)
  for (const s of ['API Error: 529 Overloaded', 'getaddrinfo ENOTFOUND api.anthropic.com', 'The hub restarted during this run']) assert.ok(!isAuthFailure(s), s)
})

test('a credential breaks once, collects what failed, and comes back clean', () => {
  let r = probed(START, 'login', 'ok', AT)
  assert.deepEqual([r.health.login.state, r.change], ['ok', null])
  r = failed(r.health, 'login', { what: 'Monitor "Prep"', monitorId: 'prep', at: AT })
  assert.deepEqual([r.health.login.state, r.change], ['needs-you', 'broke'])
  // More failures while it's broken: no new "broke", the same monitor only once.
  r = failed(r.health, 'login', { what: 'Monitor "Prep"', monitorId: 'prep', at: AT })
  r = failed(r.health, 'login', { what: 'Worker "x"', at: AT })
  assert.equal(r.change, null)
  assert.deepEqual(r.health.login.failed.map((f) => f.what), ['Monitor "Prep"', 'Worker "x"'])
  // A network error changes nothing but the time.
  r = probed(r.health, 'login', 'other', '2026-11-24T11:00:00.000Z')
  assert.deepEqual([r.health.login.state, r.change, r.health.login.checkedAt], ['needs-you', null, '2026-11-24T11:00:00.000Z'])
  r = probed(r.health, 'login', 'ok', AT)
  assert.deepEqual([r.health.login.state, r.change, r.health.login.failed], ['ok', 'fixed', []])
  // The token: none is fine; a refused one needs the user.
  r = probed(r.health, 'token', 'none', AT)
  assert.deepEqual([r.health.token.state, r.change], ['none', null])
  r = probed(r.health, 'token', 'auth', AT)
  assert.deepEqual([r.health.token.state, r.change], ['needs-you', 'broke'])
})

test('one alert while anything needs the user, worded for what broke', () => {
  assert.equal(alertText(START), null)
  const login = failed(START, 'login', { what: 'The Assistant', at: AT }).health
  assert.deepEqual(alertText(login), { title: 'Claude needs you to sign in again', body: 'Stopped: The Assistant' })
  const token = probed(START, 'token', 'auth', AT).health
  assert.equal(alertText(token)?.title, "Claude's background token needs renewing")
})

test('the token file: an EnvironmentFile line, its made-on date, a year to run', () => {
  const text = tokenFileText(FAKE_TOKEN, '2026-09-05')
  assert.match(text, /^# .*made 2026-09-05/)
  assert.match(text, new RegExp(`^CLAUDE_CODE_OAUTH_TOKEN=${FAKE_TOKEN}$`, 'm'))
  assert.deepEqual(readTokenFile(text), { token: FAKE_TOKEN, madeOn: '2026-09-05' })
  assert.deepEqual(readTokenFile(`CLAUDE_CODE_OAUTH_TOKEN="${FAKE_TOKEN}"\n`), { token: FAKE_TOKEN, madeOn: null })
  assert.equal(readTokenFile('# nothing\n'), null)
  assert.equal(tokenEndsOn('2026-09-05'), '2027-09-05')
  assert.equal(tokenDaysLeft('2026-09-05', Date.parse('2027-08-06T00:00:00Z')), 30)
  assert.equal(tokenDaysLeft(null, 0), null)
})

test("setup-token's link (a terminal app's output) and its token", () => {
  const start = readFileSync(new URL('./fixtures/setup-token-start.txt', import.meta.url), 'utf8')
  assert.deepEqual(signInLink('claude', start), { url: 'https://claude.ai/oauth/authorize?FIXTUREID', userCode: null, wantsCode: true })
  const end = `${start}\u001b[2K\u001b[1G\u001b[32m✓\u001b[39m\u001b[3GLong-lived\u001b[14Gauthentication\u001b[29Gtoken\u001b[35Gcreated\u001b[43Gsuccessfully!\r\r\n\r\r\nYour\u001b[6GOAuth\u001b[12Gtoken\u001b[18G(valid\u001b[25Gfor\u001b[29G1\u001b[31Gyear):\r\r\n\r\r\n\u001b[1m${FAKE_TOKEN}\u001b[22m\r\r\n`
  assert.equal(setupTokenFrom(end), FAKE_TOKEN)
  assert.equal(setupTokenFrom(start), null)
})

// ---------- adapters ----------

test('the token file is private, written whole, and read on every use', () => {
  const f = new ClaudeTokenFile(join(tmp(), 'claude-token.env'))
  assert.deepEqual([f.read(), f.env()], [null, {}])
  f.write(FAKE_TOKEN, '2026-11-24')
  assert.equal(statSync(f.path).mode & 0o777, 0o600)
  assert.deepEqual(f.env(), { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN })
  f.write(`${FAKE_TOKEN}2`, '2026-11-25')
  assert.deepEqual(f.read(), { token: `${FAKE_TOKEN}2`, madeOn: '2026-11-25' })
})

test('the probe: ok, refused (auth), or could not tell; the login probe never carries a token', async () => {
  const dir = tmp()
  const bin = join(dir, 'claude')
  script(bin, `echo "token=[\${CLAUDE_CODE_OAUTH_TOKEN:-}]" > "${dir}/seen"
case "\${CLAUDE_CODE_OAUTH_TOKEN:-}" in
  good) echo ok ;;
  "") [ -f "${dir}/offline" ] && { echo "getaddrinfo ENOTFOUND" >&2; exit 1; }
      [ -f "${dir}/expired" ] && { echo "Failed to authenticate: OAuth session expired and could not be refreshed" >&2; exit 1; }
      echo ok ;;
  *) echo "Failed to authenticate. API Error: 401 OAuth access token is invalid." >&2; exit 1 ;;
esac`)
  const probe = new ClaudeProbe({ bin: () => bin, env: () => ({ PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'leaked' }) })
  assert.equal((await probe.run(null)).outcome, 'ok')
  assert.equal(readFileSync(join(dir, 'seen'), 'utf8').trim(), 'token=[]')
  assert.equal((await probe.run('good')).outcome, 'ok')
  const bad = await probe.run('bad-token-value')
  assert.equal(bad.outcome, 'auth')
  writeFileSync(join(dir, 'expired'), '')
  assert.equal((await probe.run(null)).outcome, 'auth')
  writeFileSync(join(dir, 'offline'), '')
  assert.equal((await probe.run(null)).outcome, 'other')
  assert.equal((await new ClaudeProbe({ bin: () => join(dir, 'missing'), env: () => ({}) }).run(null)).outcome, 'other')
})

test('setup-token runs in a pseudo-terminal; the code goes in with Enter; keep gets the output before done', { skip: process.platform === 'win32' }, async () => {
  assert.deepEqual(signInCommand('claude', 'subscription', '/x/claude'), { cmd: '/x/claude', args: ['auth', 'login', '--claudeai'] })
  assert.deepEqual(signInCommand('claude', 'token', "/x/it's/claude", 'linux').args, ['-qfec', `stty cols 1000 rows 50 2>/dev/null; exec '/x/it'\\''s/claude' setup-token`, '/dev/null'])
  assert.equal(signInCommand('claude', 'token', '/x/claude', 'darwin').args[0], '-q')
  const dir = tmp()
  const bin = join(dir, 'claude')
  script(bin, `[ "$1" = setup-token ] || exit 3
[ -t 0 ] || { echo "not a terminal"; exit 4; }
printf 'Browser didn'"'"'t open? Use the URL below to sign in\\n\\nhttps://claude.ai/oauth/authorize?abc\\n\\nPaste code here if prompted > '
read code
[ "$code" = "good#s" ] || { echo "Error: That code wasn't accepted"; exit 1; }
printf 'Your OAuth token (valid for 1 year):\\n\\n${FAKE_TOKEN}\\n'`)
  const kept: string[] = []
  const s = new CliSignIn({ keep: async (_a, how, out) => { if (how === 'token') kept.push(setupTokenFrom(out) ?? 'none') } })
  let r = await s.start('claude', 'token', bin, () => {})
  assert.deepEqual([r.state, r.how, r.link], ['waiting', 'token', { url: 'https://claude.ai/oauth/authorize?abc', userCode: null, wantsCode: true }])
  r = await s.sendCode('claude', 'good#s')
  assert.equal(r.state, 'done', r.error ?? '')
  assert.deepEqual(kept, [FAKE_TOKEN])
  // keep throwing fails the sign-in with its words.
  const s2 = new CliSignIn({ keep: async () => { throw new Error('no token in it') } })
  await s2.start('claude', 'token', bin, () => {})
  r = await s2.sendCode('claude', 'good#s')
  assert.deepEqual([r.state, r.error], ['failed', 'no token in it'])
})

// ---------- the check ----------

function rig(o: { token?: boolean } = {}) {
  const outcomes: Record<'login' | 'token', ProbeOutcome> = { login: 'ok', token: 'ok' }
  let saved: any = null
  const calls = { signIn: [] as ({ title: string; body: string } | null)[], remind: [] as string[], retried: [] as string[], news: [] as string[] }
  const file = new ClaudeTokenFile(join(tmp(), 'claude-token.env'))
  if (o.token !== false) file.write(FAKE_TOKEN, '2026-09-05')
  let now = Date.parse(AT)
  const h = new ClaudeHealth({
    probe: { run: async (token) => ({ outcome: outcomes[token ? 'token' : 'login'], detail: '' }) },
    tokenFile: file,
    store: { read: () => saved, write: (s) => { saved = structuredClone(s) } },
    bell: { signIn: async (a) => { calls.signIn.push(a) }, remind: async (t) => { calls.remind.push(t) } },
    retryMonitor: async (id) => { calls.retried.push(id) },
    news: async (t) => { calls.news.push(t) },
    now: () => now,
    log: () => {},
  })
  return { h, outcomes, calls, file, saved: () => saved, setNow: (ms: number) => { now = ms } }
}

test('a broken login: one bell item, more failures only update it; signing in again clears it and reruns monitors', async () => {
  const r = rig()
  await r.h.check()
  assert.equal(r.calls.signIn.length, 0)
  assert.equal(r.h.view().login.state, 'ok')
  // A monitor fails on the token, then the login breaks too.
  await r.h.reported('background', { what: 'Monitor "Prep"', monitorId: 'prep' })
  assert.equal(r.h.view().token.state, 'needs-you')
  assert.equal(r.calls.signIn.length, 1)
  r.outcomes.login = 'auth'
  await r.h.check()
  assert.equal((r.calls.signIn.at(-1) as { title: string } | null)?.title, 'Claude needs you to sign in again')
  await r.h.reported('login', { what: 'Worker "x"' })
  // Fixed: the probe works again.
  r.outcomes.login = 'ok'
  await r.h.check()
  assert.deepEqual(r.calls.retried, ['prep'])
  assert.equal(r.calls.signIn.at(-1), null)
  assert.match(r.calls.news.join('\n'), /sign-in is back[\s\S]*Worker "x"/)
  assert.match(r.calls.news.join('\n'), /Monitors run again: prep/)
  // Saved between restarts.
  assert.equal(r.saved().health.login.state, 'ok')
})

test('background failures land on the login when there is no token; the token warns a month before it ends, once', async () => {
  const r = rig({ token: false })
  await r.h.reported('background', { what: 'Monitor "Prep"', monitorId: 'prep' })
  assert.equal(r.h.view().login.state, 'needs-you')
  assert.equal(r.h.view().token.state, 'none')

  const t = rig()
  t.setNow(Date.parse('2027-08-10T00:00:00Z'))
  await t.h.check()
  await t.h.check()
  assert.deepEqual(t.calls.remind, ["Claude's background token runs out on 2027-09-05"])
  assert.equal(t.h.view().token.daysLeft, 26)
})

test('a renewed token goes to the file; output without one fails the sign-in', () => {
  const r = rig({ token: false })
  assert.throws(() => r.h.saveToken('nothing here'), /couldn't find the token/)
  r.h.saveToken(`Your OAuth token (valid for 1 year):\n${FAKE_TOKEN}\n`)
  assert.deepEqual(r.file.read(), { token: FAKE_TOKEN, madeOn: '2026-11-24' })
})
