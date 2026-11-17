import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_PACKAGES, claudeSignIn, cleanCode, cleanKey, codexSignIn, isOlder, parseVersion, pickerNote, signInFailure, signInLink,
} from '../src/domain/agent-setup.ts'
import { claudeGroup, codexGroup } from '../src/domain/models.ts'
import { AgentCli, findAgentBin } from '../src/adapters/agent-cli.ts'
import { NpmInstall, installArgs, quietCodex } from '../src/adapters/agent-install.ts'
import { CliSignIn, signInArgs } from '../src/adapters/agent-sign-in.ts'
import { KeyFile, keychainAddCommand } from '../src/adapters/agent-keys.ts'
import { Agents } from '../src/app/agents.ts'
import type { AgentStatus } from '../src/domain/models.ts'
import type { InstallRun, SignInRun } from '../src/ports.ts'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'limeade3a-test-'))
  dirs.push(d)
  return d
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// What the real CLIs print (Claude Code 2.1.311, Codex 0.166.0), colours and link markers included.
const CLAUDE_LOGIN = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: \u001b]8;;https://claude.com/cai/oauth/authorize?code=true&state=abc\u0007https://claude.com/cai/oauth/authorize?code=true&state=abc\u001b]8;;\u0007\nPaste code here if prompted > '
const CODEX_LOGIN = 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mMOEM-FS9X9\u001b[0m\n'

test('versions and sign-in states come from what the CLIs print', () => {
  assert.equal(parseVersion('2.1.311 (Claude Code)'), '2.1.311')
  assert.equal(parseVersion('codex-cli 0.166.0'), '0.166.0')
  assert.equal(parseVersion('nope'), null)
  assert.ok(isOlder('2.1.300', '2.1.311'))
  assert.ok(isOlder('0.99.9', '0.166.0'))
  assert.ok(!isOlder('2.1.311', '2.1.311'))
  assert.ok(!isOlder('3.0.0', '2.9.9'))
  assert.deepEqual(claudeSignIn('{"loggedIn":true,"authMethod":"claude.ai","email":"b@x"}'), { signedIn: true, how: 'subscription', account: 'b@x' })
  assert.deepEqual(claudeSignIn('{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}'), { signedIn: true, how: 'api-key', account: null })
  assert.deepEqual(claudeSignIn('{"loggedIn":false,"authMethod":"none"}'), { signedIn: false, how: null, account: null })
  assert.deepEqual(claudeSignIn('not json'), { signedIn: false, how: null, account: null })
  assert.deepEqual(codexSignIn('Logged in using ChatGPT', true), { signedIn: true, how: 'chatgpt', account: null })
  assert.deepEqual(codexSignIn('Logged in using an API key - sk-proj-***abcd', true), { signedIn: true, how: 'api-key', account: null })
  assert.deepEqual(codexSignIn('Not logged in', false), { signedIn: false, how: null, account: null })
})

test('the picker says not installed or not signed in; model groups go offline until the agent is ready', () => {
  assert.equal(pickerNote({ installed: false, signedIn: false }), 'not installed')
  assert.equal(pickerNote({ installed: true, signedIn: false }), 'not signed in')
  assert.equal(pickerNote({ installed: true, signedIn: true }), null)
  assert.deepEqual([claudeGroup({}).title, claudeGroup({}).online], ['Claude · your subscription', true]) // a hub that doesn't know
  assert.deepEqual([claudeGroup({}, { installed: false, signedIn: false }).title, claudeGroup({}, { installed: false, signedIn: false }).online], ['Claude · not installed', false])
  assert.equal(claudeGroup({}, { installed: true, signedIn: false }).title, 'Claude · not signed in')
  assert.equal(claudeGroup({}, { installed: true, signedIn: true, how: 'api-key' }).title, 'Claude · your API key')
  assert.equal(codexGroup({ installed: true, signedIn: true, how: 'api-key' }).title, 'Codex · your API key')
  assert.equal(codexGroup({ installed: true, signedIn: true, how: 'chatgpt' }).title, 'Codex · your OpenAI sign-in')
})

test('the sign-in link (and Codex code) are read out of the CLI output once complete; failures in its words', () => {
  assert.deepEqual(signInLink('claude', CLAUDE_LOGIN), { url: 'https://claude.com/cai/oauth/authorize?code=true&state=abc', userCode: null, wantsCode: true })
  assert.equal(signInLink('claude', 'Opening browser to sign in…\n'), null)
  assert.deepEqual(signInLink('codex', CODEX_LOGIN), { url: 'https://auth.openai.com/codex/device', userCode: 'MOEM-FS9X9', wantsCode: false })
  assert.equal(signInLink('codex', CODEX_LOGIN.slice(0, 200)), null) // the code hasn't come yet
  assert.equal(signInFailure("Paste code here if prompted > Login failed: That code wasn't accepted. Sign in again.\n"), "That code wasn't accepted. Sign in again.")
  assert.equal(signInFailure('all good'), null)
})

test('pasted keys and codes are trimmed and must look like one', () => {
  assert.equal(cleanKey('  sk-ant-api03-abcdefghijklmnopqrstuvwxyz \n'), 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
  assert.equal(cleanKey('short'), null)
  assert.equal(cleanKey('has a space in the middle of it ok'), null)
  assert.equal(cleanKey(42), null)
  assert.equal(cleanCode(' abcdefgh#state \n'), 'abcdefgh#state')
  assert.equal(cleanCode(''), null)
})

test("an agent's command: Limeade's install folder first, then PATH", () => {
  const prefix = tmp()
  const other = tmp()
  mkdirSync(join(prefix, 'bin'))
  script(join(other, 'codex'), 'exit 0')
  assert.equal(findAgentBin('codex', prefix, other), join(other, 'codex'))
  script(join(prefix, 'bin', 'codex'), 'exit 0')
  assert.equal(findAgentBin('codex', prefix, other), join(prefix, 'bin', 'codex'))
  assert.equal(findAgentBin('claude', prefix, other), null)
  assert.equal(findAgentBin(join(other, 'codex'), prefix, ''), join(other, 'codex'))
  assert.equal(findAgentBin(join(other, 'nope'), prefix, ''), null)
})

/** A stand-in Claude Code: version, auth status (signed in when a file says so or a key is set) and login. */
function fakeClaude(dir: string, version = '2.1.300') {
  const bin = join(dir, 'claude')
  script(bin, `d=$(dirname "$0")
case "$1 $2" in
  "--version ") echo "${version} (Claude Code)" ;;
  "auth status")
    if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}'; exit 0; fi
    if [ -f "$d/signed-in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","email":"b@x"}'; exit 0; fi
    echo '{"loggedIn":false,"authMethod":"none"}'; exit 1 ;;
  "auth login")
    echo "$3" > "$d/how"
    printf 'Opening browser to sign in\\nIf the browser didn'"'"'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s1\\nPaste code here if prompted > '
    read code
    if [ "$code" = "good#s1" ]; then touch "$d/signed-in"; echo "Login successful."; exit 0; fi
    echo "Login failed: That code wasn't accepted. Sign in again to get a new code." >&2; exit 1 ;;
esac`)
  return bin
}

/** A stand-in Codex: version, login status, and a device sign-in that finishes when a file appears. */
function fakeCodex(dir: string, version = '0.166.0') {
  const bin = join(dir, 'codex')
  script(bin, `d=$(dirname "$0")
case "$1 $2" in
  "--version ") echo "codex-cli ${version}" ;;
  "login status") if [ -f "$d/signed-in" ]; then echo "Logged in using ChatGPT"; exit 0; fi; echo "Not logged in"; exit 1 ;;
  "login --device-auth")
    printf '1. Open this link in your browser and sign in to your account\\n   https://auth.openai.com/codex/device\\n\\n2. Enter this one-time code (expires in 15 minutes)\\n   ABCD-12345\\n'
    while [ ! -f "$d/approve" ]; do sleep 0.05; done
    touch "$d/signed-in"; echo "Successfully logged in"; exit 0 ;;
esac`)
  return bin
}

test('Claude Code and Codex: installed, version, signed in and how, from their own CLIs', async () => {
  const prefix = tmp()
  const dir = join(prefix, 'bin')
  mkdirSync(dir)
  const claude = fakeClaude(dir)
  const codex = fakeCodex(tmp())
  const c = new AgentCli({ agent: 'claude', find: () => claude, prefix, env: () => ({ PATH: process.env.PATH }) })
  assert.deepEqual(await c.status(), { installed: true, signedIn: false, version: '2.1.300', path: claude, managed: true, how: null, account: null })
  writeFileSync(join(dir, 'signed-in'), '')
  assert.equal((await c.status()).signedIn, false) // remembered for a while…
  c.forget()
  assert.deepEqual(await c.status(), { installed: true, signedIn: true, version: '2.1.300', path: claude, managed: true, how: 'subscription', account: 'b@x' })
  const keyed = new AgentCli({ agent: 'claude', find: () => claude, prefix: tmp(), env: () => ({ PATH: process.env.PATH, ANTHROPIC_API_KEY: 'k' }) })
  assert.equal((await keyed.status()).how, 'api-key')
  assert.equal((await keyed.status()).managed, false) // not in Limeade's folder: the user's own install

  const x = new AgentCli({ agent: 'codex', find: () => codex, prefix, env: () => ({ PATH: process.env.PATH }) })
  assert.deepEqual(await x.status(), { installed: true, signedIn: false, version: '0.166.0', path: codex, managed: false, how: null, account: null })
  const xKey = new AgentCli({ agent: 'codex', find: () => codex, prefix, env: () => ({ CODEX_API_KEY: 'k' }) })
  assert.equal((await xKey.status()).how, 'api-key')
  const none = new AgentCli({ agent: 'codex', find: () => null, prefix })
  assert.deepEqual(await none.status(), { installed: false, signedIn: false, version: null, path: null, managed: false, how: null, account: null })
})

test('installing runs npm for the pinned package into the prefix; a failure keeps npm\'s last words', async () => {
  const prefix = join(tmp(), 'agents')
  assert.deepEqual(installArgs('codex', prefix), ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error', `@openai/codex@${AGENT_PACKAGES.codex.version}`])
  const npmDir = tmp()
  const npm = join(npmDir, 'npm')
  // Puts a codex command under --prefix, as npm would; fails for Claude.
  script(npm, `[ "$npm_config_update_notifier" = false ] || exit 9
case "$9" in
  @openai/*) mkdir -p "$4/bin"; printf '#!/bin/sh\\necho "codex-cli 0.166.0"\\n' > "$4/bin/codex"; chmod +x "$4/bin/codex" ;;
  *) echo "npm error code E404" >&2; echo "npm error 404 Not Found" >&2; exit 1 ;;
esac`)
  const inst = new NpmInstall({ prefix, npm })
  const finished = (agent: 'claude' | 'codex') => new Promise<InstallRun>((resolve) => {
    const r = inst.start(agent, () => resolve(inst.run(agent)!))
    assert.equal(r.running, true)
  })
  const ok = await finished('codex')
  assert.deepEqual([ok.running, ok.error], [false, null])
  assert.ok(existsSync(join(prefix, 'bin', 'codex')))
  const bad = await finished('claude')
  assert.equal(bad.running, false)
  assert.match(bad.error!, /404 Not Found/)
})

test('a Codex that Limeade installs gets telemetry and update checks off, unless it already has settings', () => {
  const home = join(tmp(), '.codex')
  assert.equal(quietCodex(home), true)
  const toml = readFileSync(join(home, 'config.toml'), 'utf8')
  assert.match(toml, /check_for_update_on_startup = false/)
  assert.match(toml, /\[analytics\]\nenabled = false/)
  assert.match(toml, /\[feedback\]\nenabled = false/)
  assert.match(toml, /exporter = "none"/)
  writeFileSync(join(home, 'config.toml'), 'model = "mine"\n')
  assert.equal(quietCodex(home), false)
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), 'model = "mine"\n')
})

test("Claude's sign-in: the link shows, the pasted code goes to the CLI, a bad code fails in its words", async () => {
  assert.deepEqual(signInArgs('claude', 'console'), ['auth', 'login', '--console'])
  assert.deepEqual(signInArgs('codex', 'chatgpt'), ['login', '--device-auth'])
  const dir = tmp()
  const bin = fakeClaude(dir)
  const s = new CliSignIn()
  let ended = 0
  let r = await s.start('claude', 'subscription', bin, () => ended++)
  assert.equal(r.state, 'waiting')
  assert.deepEqual(r.link, { url: 'https://claude.com/cai/oauth/authorize?code=true&state=s1', userCode: null, wantsCode: true })
  assert.equal(readFileSync(join(dir, 'how'), 'utf8').trim(), '--claudeai')
  r = await s.sendCode('claude', 'bad#s1')
  assert.equal(r.state, 'failed')
  assert.match(r.error!, /That code wasn't accepted/)
  assert.equal(ended, 1)
  await assert.rejects(s.sendCode('claude', 'good#s1'), /Start the sign-in first/)
  r = await s.start('claude', 'subscription', bin, () => ended++)
  r = await s.sendCode('claude', 'good#s1')
  assert.equal(r.state, 'done')
  assert.ok(existsSync(join(dir, 'signed-in')))
})

test("Codex's sign-in: link and one-time code show; done once the page is finished; cancel stops it", async () => {
  const dir = tmp()
  const bin = fakeCodex(dir)
  const s = new CliSignIn()
  const r = await s.start('codex', 'chatgpt', bin, () => {})
  assert.deepEqual([r.state, r.link], ['waiting', { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345', wantsCode: false }])
  s.cancel('codex')
  assert.equal(s.run('codex'), null)
  const done = new Promise<SignInRun>((resolve) => {
    void s.start('codex', 'chatgpt', bin, () => resolve(s.run('codex')!)).then(() => writeFileSync(join(dir, 'approve'), ''))
  })
  assert.equal((await done).state, 'done')
  const quiet = join(dir, 'silent')
  script(quiet, 'sleep 5')
  const none = await new CliSignIn({ startMs: 200 }).start('codex', 'chatgpt', quiet, () => {})
  assert.deepEqual([none.state, none.error], ['failed', "The sign-in link didn't come. Start again."])
})

test('API keys Limeade keeps: a 0600 file off the Mac; Keychain input is quoted for security -i', async () => {
  const file = join(tmp(), 'cfg', 'agent-keys.json')
  const keys = new KeyFile(file)
  assert.equal(await keys.get('claude-api-key'), null)
  await keys.set('claude-api-key', 'sk-ant-1')
  assert.equal(await keys.get('claude-api-key'), 'sk-ant-1')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  await keys.remove('claude-api-key')
  assert.equal(await keys.get('claude-api-key'), null)
  assert.equal(keychainAddCommand('codex-api-key', 'a"b\\c'), 'add-generic-password -U -s "Limeade" -a "codex-api-key" -w "a\\"b\\\\c"\n')
})

function fakes(status: Partial<Record<'claude' | 'codex', AgentStatus>> = {}) {
  const st: Record<'claude' | 'codex', AgentStatus> = {
    claude: { installed: true, signedIn: true, version: '2.1.311', path: '/x/claude', managed: false, how: 'subscription', account: null },
    codex: { installed: false, signedIn: false, version: null, path: null, managed: false, how: null, account: null },
    ...status,
  }
  const forgot: string[] = []
  const setups = {
    claude: { status: async () => st.claude, forget: () => forgot.push('claude') },
    codex: { status: async () => st.codex, forget: () => forgot.push('codex') },
  }
  const runs = new Map<string, InstallRun>()
  const ends: (() => void)[] = []
  const installer = {
    start: (a: 'claude' | 'codex', done: () => void) => {
      const r = { version: AGENT_PACKAGES[a].version, running: true, error: null, log: '' }
      runs.set(a, r)
      ends.push(() => { r.running = false; done() })
      return r
    },
    run: (a: 'claude' | 'codex') => runs.get(a) ?? null,
  }
  const signIns: string[] = []
  const signIn = {
    start: async (a: 'claude' | 'codex', how: string, bin: string) => { signIns.push(`${a}:${how}:${bin}`); return { state: 'waiting' as const, link: null, error: null } },
    sendCode: async () => { throw new Error('Start the sign-in first') },
    run: () => null,
    cancel: () => {},
  }
  const stored = new Map<string, string>()
  const keys = { get: async (n: string) => stored.get(n) ?? null, set: async (n: string, v: string) => { stored.set(n, v) }, remove: async (n: string) => { stored.delete(n) } }
  const keyEnv = { claude: [{} as Record<string, string | undefined>, {} as Record<string, string | undefined>], codex: [{} as Record<string, string | undefined>] }
  const installed: string[] = []
  const agents = new Agents({ setups, installer, signIn, keys, keyEnv, installed: (a) => installed.push(a) })
  const events: unknown[] = []
  agents.on('agents', (e) => events.push(e))
  return { st, agents, forgot, ends, signIns, stored, keyEnv, installed, events }
}

test('Settings › Agents lists both agents with what Limeade would install and whether it can update', async () => {
  const f = fakes({ codex: { installed: true, signedIn: false, version: '0.150.0', path: '/p/bin/codex', managed: true } })
  const [claude, codex] = await f.agents.list()
  assert.deepEqual([claude!.agent, claude!.name, claude!.update, claude!.keySaved], ['claude', 'Claude Code', null, false])
  assert.deepEqual([codex!.name, codex!.pinned, codex!.update], ['Codex', AGENT_PACKAGES.codex.version, AGENT_PACKAGES.codex.version])
  f.st.codex = { ...f.st.codex, managed: false }
  assert.equal((await f.agents.view('codex')).update, null) // the user's own install: theirs to update
})

test('installing: only a missing (or Limeade-updatable) agent; when done the status is asked again', async () => {
  const f = fakes()
  await assert.rejects(f.agents.install('claude'), /already installed/)
  await assert.rejects(f.agents.install('gemini'), /No such agent/)
  const v = await f.agents.install('codex')
  assert.equal(v.install!.running, true)
  f.ends[0]!()
  assert.deepEqual(f.forgot, ['codex'])
  assert.deepEqual(f.installed, ['codex'])
  assert.equal(f.events.length, 2) // started, finished
})

test('sign-in needs the agent installed and a way it supports; it runs the installed command', async () => {
  const f = fakes()
  await assert.rejects(f.agents.startSignIn('codex', 'chatgpt'), /Install Codex first/)
  await assert.rejects(f.agents.startSignIn('claude', 'chatgpt'), /can't sign in that way/)
  await f.agents.startSignIn('claude', 'console')
  assert.deepEqual(f.signIns, ['claude:console:/x/claude'])
  await assert.rejects(f.agents.sendCode('claude', ''), /Paste the code/)
  await assert.rejects(f.agents.sendCode('claude', 'abcdefgh#s'), /Start the sign-in first/)
})

test('an API key is kept by Limeade and put in the agent\'s environment, at once and on the next start', async () => {
  const f = fakes()
  await assert.rejects(f.agents.saveKey('claude', 'nope'), /doesn't look like an API key/)
  const v = await f.agents.saveKey('claude', ' sk-ant-api03-abcdefghijklmnopqrst ')
  assert.equal(v.keySaved, true)
  assert.equal(f.stored.get('claude-api-key'), 'sk-ant-api03-abcdefghijklmnopqrst')
  assert.deepEqual(f.keyEnv.claude.map((e) => e.ANTHROPIC_API_KEY), ['sk-ant-api03-abcdefghijklmnopqrst', 'sk-ant-api03-abcdefghijklmnopqrst'])
  assert.deepEqual(f.forgot, ['claude'])
  await f.agents.saveKey('codex', 'sk-proj-abcdefghijklmnopqrstuvwx')
  assert.equal(f.keyEnv.codex[0]!.CODEX_API_KEY, 'sk-proj-abcdefghijklmnopqrstuvwx')

  // A restarted hub reads them back.
  const g = fakes()
  for (const [k, v] of f.stored) g.stored.set(k, v)
  await g.agents.load()
  assert.equal(g.keyEnv.claude[1]!.ANTHROPIC_API_KEY, 'sk-ant-api03-abcdefghijklmnopqrst')

  await f.agents.removeKey('claude')
  assert.equal(f.stored.has('claude-api-key'), false)
  assert.deepEqual(f.keyEnv.claude.map((e) => 'ANTHROPIC_API_KEY' in e), [false, false])
  assert.equal((await f.agents.view('claude')).keySaved, false)
})
