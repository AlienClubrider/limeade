#!/usr/bin/env node
// Installs Limeade on this computer and runs it as a background service, then manages it.
//   npx -y github:<owner>/limeade            install or update, start, open http://localhost:8797
//   limeade status | start | stop | restart | logs | open | phone <name> | uninstall [--all]
//   limeade monitor …                        the Assistant's recurring jobs (src/cli/monitor.ts)
//   limeade claude-sign-in [check | failed …] is Claude's sign-in working? (src/cli/claude-sign-in.ts)
// Plain JavaScript on purpose: npx runs this from node_modules, where Node won't run TypeScript. The app
// itself is copied out to its own folder and runs from there. Only Node 24 (with its npm) is needed.

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = homedir()
const MAC = platform() === 'darwin'
const LABEL = 'com.limeade.hub'
const UNIT = 'limeade.service'
const xdg = (name, fallback) => process.env[name] || join(HOME, fallback)
const APP = join(xdg('XDG_DATA_HOME', '.local/share'), 'limeade', 'app')
const CONFIG = join(xdg('XDG_CONFIG_HOME', '.config'), 'limeade')
const STATE = join(xdg('XDG_STATE_HOME', '.local/state'), 'limeade')
const ENV_FILE = join(CONFIG, 'limeade.env')
const LINK = join(HOME, '.local', 'bin', 'limeade')
const PLIST = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const UNIT_FILE = join(xdg('XDG_CONFIG_HOME', '.config'), 'systemd', 'user', UNIT)
const LOG = MAC ? join(HOME, 'Library', 'Logs', 'Limeade', 'limeade.log') : null
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
/** What the app needs to run; tests, docs and the like stay behind. */
const APP_FILES = ['package.json', 'npm-shrinkwrap.json', 'bin', 'src', 'public', 'defaults', 'README.md', 'LICENSE']

const say = (line = '') => process.stdout.write(`${line}\n`)
function die(msg) {
  process.stderr.write(`limeade: ${msg}\n`)
  process.exit(1)
}

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { stdio: o.quiet ? 'pipe' : 'inherit', encoding: 'utf8', env: o.env ?? process.env, cwd: o.cwd })
  if (r.error) {
    if (o.ok) return r
    die(`${cmd} didn't run: ${r.error.message}`)
  }
  if (r.status !== 0 && !o.ok) die(`${cmd} ${args.join(' ')} failed${r.stderr ? `: ${r.stderr.trim().slice(-400)}` : ''}`)
  return r
}

/** Settings from limeade.env (KEY=value lines). */
function readEnv() {
  const env = {}
  if (!existsSync(ENV_FILE)) return env
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) env[m[1]] = m[2].trim()
  }
  return env
}
const port = () => Number(readEnv().PORT || 8797)
const url = () => `http://localhost:${port()}`

function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) die(`Limeade needs Node 24 or newer (this is ${process.versions.node}). Get it from https://nodejs.org, then run this again.`)
}

/** npm from the same Node, with its nags and phoning home turned off. */
function npm(args, cwd) {
  const bin = join(dirname(process.execPath), MAC || platform() === 'linux' ? 'npm' : 'npm.cmd')
  const env = { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', DO_NOT_TRACK: '1' }
  run(existsSync(bin) ? bin : 'npm', args, { cwd, env, quiet: true })
}

function writeEnvFile(p) {
  mkdirSync(CONFIG, { recursive: true, mode: 0o700 })
  if (existsSync(ENV_FILE)) {
    // An update with --port changes the port; everything else stays as the user set it.
    const text = readFileSync(ENV_FILE, 'utf8')
    if (Number(readEnv().PORT || 8797) !== p) writeFileSync(ENV_FILE, /^PORT=.*$/m.test(text) ? text.replace(/^PORT=.*$/m, `PORT=${p}`) : `PORT=${p}\n${text}`, { mode: 0o600 })
    return
  }
  writeFileSync(ENV_FILE, [
    '# Limeade settings. After a change: limeade restart',
    `PORT=${p}`,
    '# Where the Assistant and new chats work (default: your home folder).',
    '# WORK_DIR=~/dev',
    '# Ollama (also in Settings › Local models). Default: http://localhost:11434',
    '# OLLAMA_URL=http://localhost:11434',
    '# Other names this computer is reached by (limeade phone <name> adds one).',
    '# TRUSTED_HOSTS=',
    '',
  ].join('\n'), { mode: 0o600 })
}

/** The PATH the service runs with: this Node first, the agents' folder, then what this shell has. */
function servicePath() {
  const parts = [dirname(process.execPath), join(HOME, '.local', 'bin'), ...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  // Not npx's own short-lived folders.
  return [...new Set(parts.filter((d) => d && !/node_modules|[\\/]_npx[\\/]/.test(d)))].join(':')
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function writeService() {
  const node = process.execPath
  const args = [node, `--env-file-if-exists=${ENV_FILE}`, join(APP, 'src', 'main.ts')]
  const env = { PATH: servicePath(), DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1' }
  if (MAC) {
    mkdirSync(dirname(PLIST), { recursive: true })
    mkdirSync(dirname(LOG), { recursive: true })
    writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(APP)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- A restart stops only the hub: running agent turns carry on and the next hub picks them up. -->
  <key>AbandonProcessGroup</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`)
  } else {
    mkdirSync(dirname(UNIT_FILE), { recursive: true })
    const q = (a) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)
    writeFileSync(UNIT_FILE, `[Unit]
Description=Limeade (${url()})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP}
ExecStart=${args.map(q).join(' ')}
Restart=always
RestartSec=5
# A restart stops only the hub: running agent turns carry on and the next hub picks them up.
KillMode=process
UMask=0077
${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}

[Install]
WantedBy=default.target
`)
  }
}

const uid = () => process.getuid?.() ?? 0

function serviceStart() {
  if (MAC) {
    run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { ok: true, quiet: true })
    run('launchctl', ['bootstrap', `gui/${uid()}`, PLIST], { quiet: true })
  } else {
    const r = run('systemctl', ['--user', 'daemon-reload'], { ok: true, quiet: true })
    if (r.status !== 0) die(`systemd isn't available for your user (${(r.stderr || r.error?.message || '').trim()}). Limeade runs as a systemd --user service on Linux.`)
    run('systemctl', ['--user', 'enable', UNIT], { quiet: true })
    run('systemctl', ['--user', 'restart', UNIT], { quiet: true })
  }
}

function serviceRestart() {
  if (MAC) run('launchctl', ['kickstart', '-k', `gui/${uid()}/${LABEL}`], { quiet: true })
  else run('systemctl', ['--user', 'restart', UNIT], { quiet: true })
}

function serviceStop() {
  if (MAC) run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { ok: true, quiet: true })
  else run('systemctl', ['--user', 'disable', '--now', UNIT], { ok: true, quiet: true })
}

/** The key scripts use; the installer makes it so it can tell its own Limeade from anything else on the port. */
function key() {
  const file = join(CONFIG, 'key')
  if (!existsSync(file)) {
    mkdirSync(CONFIG, { recursive: true, mode: 0o700 })
    writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' })
  }
  return readFileSync(file, 'utf8').trim()
}

/** Whether this Limeade (not just anything on the port) answers. */
async function up(timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  const headers = { Authorization: `Bearer ${key()}` }
  while (Date.now() < end) {
    const ok = await fetch(`http://127.0.0.1:${port()}/status`, { headers, signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Whether nothing is listening on the port (our own service is stopped first). */
function portFree(p) {
  return new Promise((done) => {
    const srv = createServer()
    srv.once('error', () => done(false))
    srv.listen(p, '127.0.0.1', () => srv.close(() => done(true)))
  })
}

function openBrowser() {
  if (process.env.LIMEADE_NO_OPEN || (!MAC && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) return false
  return run(MAC ? 'open' : 'xdg-open', [url()], { ok: true, quiet: true }).status === 0
}

function linkCommand() {
  mkdirSync(dirname(LINK), { recursive: true })
  try {
    lstatSync(LINK)
    unlinkSync(LINK)
  } catch {}
  symlinkSync(join(APP, 'bin', 'limeade.mjs'), LINK)
}

async function install(flags) {
  checkNode()
  if (HERE === APP) die('this is the installed copy; run the install command again (npx …) to update')
  const p = Number(flags.port || readEnv().PORT || 8797)
  if (!Number.isInteger(p) || p < 1024 || p > 65535) die('--port must be a number from 1024 to 65535')
  const fresh = !existsSync(APP)
  if (!fresh) serviceStop()
  if (!(await portFree(p))) die(`port ${p} is already in use on this computer. Run this again with --port <another number>, e.g. --port ${p + 1}.`)
  say(fresh ? 'Installing Limeade…' : 'Updating Limeade…')
  // Copy the app beside the old one, install its packages there, then swap: a failed update leaves the old one.
  const next = `${APP}.next`
  rmSync(next, { recursive: true, force: true })
  mkdirSync(next, { recursive: true })
  for (const f of APP_FILES) if (existsSync(join(HERE, f))) cpSync(join(HERE, f), join(next, f), { recursive: true })
  say('  getting its packages (a minute or two)…')
  npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], next)
  if (existsSync(APP)) renameSync(APP, `${APP}.old`)
  renameSync(next, APP)
  rmSync(`${APP}.old`, { recursive: true, force: true })
  writeEnvFile(p)
  key()
  mkdirSync(STATE, { recursive: true, mode: 0o700 })
  writeService()
  linkCommand()
  serviceStart()
  say('  starting…')
  if (!(await up())) die(`it didn't start; see: limeade logs`)
  say(`\nLimeade is running: ${url()}`)
  say(openBrowser() ? 'It opened in your browser.' : 'Open it in your browser.')
  say('Install it as an app from the browser (Chrome: the install icon in the address bar; Safari: File › Add to Dock).')
  if (fresh) say('First time: Settings › Get started walks you through agents, Ollama, MCP servers and notifications.')
  if (!(process.env.PATH ?? '').split(':').includes(dirname(LINK))) say(`\nThe limeade command is in ${dirname(LINK)}; add that folder to your PATH to use it.`)
}

function phone(name) {
  const host = String(name ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[:/].*$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) die('usage: limeade phone <name>, like my-mac.tail1234.ts.net')
  const env = readEnv()
  const hosts = new Set((env.TRUSTED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean))
  hosts.add(host)
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  const line = `TRUSTED_HOSTS=${[...hosts].join(',')}`
  writeFileSync(ENV_FILE, /^\s*#?\s*TRUSTED_HOSTS=.*$/m.test(text) ? text.replace(/^\s*#?\s*TRUSTED_HOSTS=.*$/m, line) : `${text}${line}\n`, { mode: 0o600 })
  serviceRestart()
  say(`Limeade now answers to ${host}. Open https://${host} on your phone.`)
}

function uninstall(all) {
  serviceStop()
  rmSync(MAC ? PLIST : UNIT_FILE, { force: true })
  if (!MAC) run('systemctl', ['--user', 'daemon-reload'], { ok: true, quiet: true })
  rmSync(APP, { recursive: true, force: true })
  try {
    if (lstatSync(LINK).isSymbolicLink()) unlinkSync(LINK)
  } catch {}
  if (all) {
    rmSync(CONFIG, { recursive: true, force: true })
    rmSync(STATE, { recursive: true, force: true })
    say('Limeade is gone, with its chats, settings and keys.')
  } else say(`Limeade is uninstalled. Your chats and settings are still in ${STATE} and ${CONFIG} (uninstall --all removes them).`)
  say('Claude Code, Codex and their sign-ins are left as they are.')
}

const argv = process.argv.slice(2)
// Options alone (npx … --port 8898) mean install.
const [cmd = 'install', ...rest] = argv[0]?.startsWith('-') ? ['install', ...argv] : argv
const flags = {}
for (let i = 0; i < rest.length; i++) if (rest[i] === '--port') flags.port = rest[++i]

switch (cmd) {
  case 'install':
  case 'update':
    await install(flags)
    break
  case 'status': {
    const ok = await up(1500)
    say(ok ? `Limeade is running: ${url()}` : 'Limeade is not answering.')
    if (!MAC) run('systemctl', ['--user', '--no-pager', 'status', UNIT], { ok: true })
    process.exit(ok ? 0 : 1)
  }
  case 'restart':
    serviceRestart()
    say((await up()) ? `Restarted: ${url()}` : 'Restarted, but it is not answering yet; see: limeade logs')
    break
  case 'start':
    serviceStart()
    say((await up()) ? `Running: ${url()}` : 'Started, but it is not answering yet; see: limeade logs')
    break
  case 'stop':
    serviceStop()
    say('Stopped until: limeade start')
    break
  case 'logs':
    if (MAC) run('tail', ['-n', '200', '-f', LOG], { ok: true })
    else run('journalctl', ['--user', '-u', UNIT, '-n', '200', '-f'], { ok: true })
    break
  case 'open':
    if (!openBrowser()) say(url())
    break
  case 'phone':
    phone(rest[0])
    break
  case 'uninstall':
    uninstall(rest.includes('--all'))
    break
  case 'monitor':
  case 'monitors':
  case 'claude-sign-in': {
    // Node runs the TypeScript from the installed copy (or a checkout), not from npx's node_modules.
    const env = { ...process.env, LIMEADE_HUB: process.env.LIMEADE_HUB || `http://127.0.0.1:${port()}` }
    const file = cmd === 'claude-sign-in' ? 'claude-sign-in.ts' : 'monitor.ts'
    const r = spawnSync(process.execPath, [join(HERE, 'src', 'cli', file), ...rest], { stdio: 'inherit', env })
    process.exit(r.status ?? 1)
  }
  default:
    say('limeade [install] [--port N] | status | start | stop | restart | logs | open | phone <name> | uninstall [--all] | monitor … | claude-sign-in …')
}
