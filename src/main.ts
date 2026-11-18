// Wires the hub together from environment settings and starts it.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, totalmem } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEnvFiles, expandHome, hubConfig } from './config.ts'
import { Conversations } from './app/conversations.ts'
import { ClaudeCli, type LocalEndpoint } from './adapters/claude-cli.ts'
import { ClaudeAcp, adapterEntry } from './adapters/claude-acp.ts'
import { ChosenEngine } from './adapters/engine-choice.ts'
import { CodexAcp, codexAdapterEntry } from './adapters/codex-acp.ts'
import { AgentCli, findAgentBin } from './adapters/agent-cli.ts'
import { NpmInstall, quietCodex } from './adapters/agent-install.ts'
import { CliSignIn } from './adapters/agent-sign-in.ts'
import { KeyFile, Keychain } from './adapters/agent-keys.ts'
import { Agents } from './app/agents.ts'
import { ChatFiles, FleetDir, HubFleetMode, InboxFile, JsonKeyValue, NoticeFile } from './adapters/files.ts'
import { UploadFiles } from './adapters/upload-files.ts'
import { HomeFolderTree } from './adapters/home-folders.ts'
import { createHub } from './adapters/http.ts'
import { LiteLlm } from './adapters/litellm.ts'
import { LocalTurns } from './adapters/local-turns.ts'
import { FleetWorkers } from './adapters/fleet-workers.ts'
import { SubscriberFile, vapidKeys, webPushSender } from './adapters/web-push.ts'
import { PushOut } from './app/push.ts'
import { ChatWatchers } from './domain/chat-watch.ts'
import { createAccessCheck } from './domain/access.ts'
import { RestartGate } from './domain/restart-gate.ts'
import { OllamaHttp } from './adapters/ollama.ts'
import { OllamaLibrary } from './adapters/ollama-library.ts'
import { LiteLlmModelsYaml } from './adapters/litellm-models-file.ts'
import { MachineModels } from './app/machine-models.ts'
import { Bin, ClaudeShelf, CodexShelf } from './adapters/agent-shelves.ts'
import { McpKeys } from './adapters/mcp-keys.ts'
import { SharedConfig } from './app/shared-config.ts'
import { ASSISTANT_ID } from './domain/chat.ts'
import { DEFAULT_ASSISTANT_MODEL } from './domain/models.ts'
import { displayFolder } from './domain/places.ts'
import type { OllamaMachine } from './domain/local-models.ts'
import { OllamaDirect } from './adapters/ollama-direct.ts'
import { HubWorkers } from './app/workers.ts'

// limeade.env wins over a variable the service or shell already had (a stale provider key, say).
applyEnvFiles(process.env, process.execArgv, (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
})
const env = process.env
const home = homedir()
const appDir = fileURLToPath(new URL('..', import.meta.url))
// All wiring comes from the environment (src/config.ts): defaults for a fresh computer, a server's own setup in its unit.
const cfg = hubConfig(env, home, appDir)
const { stateDir, configDir, port } = cfg
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '1'
mkdirSync(stateDir, { recursive: true, mode: 0o700 })
mkdirSync(configDir, { recursive: true, mode: 0o700 })

function secret(path: string, required: boolean): string | null {
  let value = ''
  try {
    value = readFileSync(path, 'utf8').trim()
  } catch {}
  if (required && value.length < 32) {
    console.error(`Refusing to start: ${path} must hold a key of at least 32 characters.`)
    process.exit(1)
  }
  return value || null
}

// The key scripts (and the bundled `fleet`) use; a fresh install makes its own.
const keyFile = join(configDir, 'key')
if (!existsSync(keyFile)) writeFileSync(keyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' })
const key = secret(keyFile, true)!
const toolboxKey = secret(join(configDir, 'toolbox-key'), false)
const settings = new JsonKeyValue(join(stateDir, 'settings.json'))
const litellmGate = new RestartGate()

// Local models: through LiteLLM to the Ollama machines in its machines file (a server's setup), or straight
// to one Ollama at the address in Settings (default http://localhost:11434).
const lm = cfg.localModels
const ollamaAt = () => (lm.kind === 'ollama' ? (settings.get().ollamaUrl || lm.url) : '')
const thisComputer = (): OllamaMachine => {
  // Ollama can use most of the memory (Apple silicon shares it with the GPU). Only this computer's is known;
  // Ollama elsewhere is judged by it too, and named by its address.
  const gb = totalmem() / 1e9
  const host = (() => {
    try {
      return new URL(ollamaAt()).hostname
    } catch {
      return 'localhost'
    }
  })()
  const here = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)
  const label = here ? cfg.machineName : `Ollama on ${host}`
  // Another computer's memory isn't known: no fit judged (0).
  return { id: 'local', label, short: here && label === 'This computer' ? 'computer' : label, url: ollamaAt(), prefix: '', fitsGb: here ? Math.round(gb * 0.65) : 0, maxGb: here ? Math.round(gb * 0.75) : 0 }
}
const localSetup = lm.kind === 'litellm' ? JSON.parse(readFileSync(lm.machinesFile, 'utf8')) : { machines: [], notes: {} }
const litellmKey = lm.kind === 'litellm' ? secret(join(configDir, 'litellm-key'), false) : null
const direct = lm.kind === 'ollama' ? new OllamaDirect({ file: join(stateDir, 'local-models.json') }) : null
const litellm = lm.kind === 'litellm' ? new LiteLlm({ url: lm.url, key: litellmKey }) : null
const localModels = (litellm ?? direct)!
const machineModels = new MachineModels({
  get machines() {
    return lm.kind === 'litellm' ? localSetup.machines : [thisComputer()]
  },
  notes: localSetup.notes ?? {},
  ollama: new OllamaHttp(),
  library: new OllamaLibrary({ file: join(stateDir, 'ollama-library.json') }),
  file: lm.kind === 'litellm' ? new LiteLlmModelsYaml({ file: lm.modelsFile, url: lm.url }) : direct!,
  gate: litellmGate,
  reloaded: () => localModels.forget(),
  log: console.log,
  users: (localSetup.modelUsers ?? []).map((u: { files: string[] }) => ({ ...u, files: u.files.map((f) => expandHome(f, home)) })),
  readText: (path) => readFile(path, 'utf8').catch(() => null),
})
// Claude Code on a local model: LiteLLM's Anthropic-style API, or Ollama's own (which wants Ollama's tag).
const localEndpoint: LocalEndpoint = lm.kind === 'litellm'
  ? { url: lm.url, key: litellmKey }
  : { get url() { return ollamaAt() }, key: null, model: (name) => direct!.tagFor(name) }

// Workers: the hub's own (a chat each, the bundled `fleet` command), or a server's fleet scripts.
const fl = cfg.fleet
const fleet = new FleetDir(fl.dir)
const fleetMode = fl.kind === 'scripts' ? fleet : new HubFleetMode()
const notices = new NoticeFile(join(stateDir, 'notices.jsonl'))
const claudeVersions = new JsonKeyValue(join(stateDir, 'claude-models.json'))
// Files the user sends; outside the state folder on a server so the Assistant (and they) can find them later.
const uploadsDir = cfg.uploadsDir
mkdirSync(uploadsDir, { recursive: true, mode: 0o700 })

const workDir = cfg.workDir
// What every agent Limeade runs is given for built-in workers: the bundled `fleet` and where it writes.
const fleetEnv: Record<string, string> = fl.kind === 'builtin'
  ? { PATH: `${join(appDir, 'bin')}${delimiter}${env.PATH ?? ''}`, FLEET_HOME: fl.dir, LIMEADE_HUB: `http://127.0.0.1:${port}`, LIMEADE_CONFIG: configDir, LIMEADE_NODE: process.execPath }
  : {}
const agentDirs = fl.kind === 'builtin' ? [uploadsDir, fl.dir] : [uploadsDir]
if (fl.kind === 'builtin') mkdirSync(join(fl.dir, 'status'), { recursive: true, mode: 0o700 })

// The agents: whatever is installed already (Limeade's own install folder first, then PATH), else where a
// one-tap install from Settings › Agents puts them. API keys saved there go into each agent's environment.
const agentsPrefix = cfg.agentsPrefix
const claudeBin = findAgentBin(cfg.claudeBin, agentsPrefix) ?? join(agentsPrefix, 'bin', 'claude')
const codexBin = findAgentBin(cfg.codexBin, agentsPrefix) ?? join(agentsPrefix, 'bin', 'codex')
const quiet = { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DO_NOT_TRACK: '1', DISABLE_AUTOUPDATER: '1' }
const claudeEnv: Record<string, string | undefined> = { ...quiet, ...fleetEnv }
const claudeAcpEnv: Record<string, string | undefined> = { ...quiet, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...fleetEnv }
const codexEnv: Record<string, string | undefined> = { ...fleetEnv }
// Chats on the Chat page work in a folder the user picks, always under home.
const homeFolders = new HomeFolderTree(cfg.chatHome)

// Keys MCP servers need: the macOS Keychain, else a private file here. Every agent gets them as
// environment variables when it starts; the agents' configs only name them.
const keyStore = await new McpKeys({
  store: process.platform === 'darwin' ? new Keychain() : new KeyFile(join(configDir, 'mcp-keys.json')),
  namesFile: join(configDir, 'mcp-key-names.json'),
}).load()
const keys = () => keyStore.values()

// Running Claude Code turns keep their output here, so they outlive a hub restart (see turn-keeper.ts).
const turnsDir = join(stateDir, 'turns')
mkdirSync(turnsDir, { recursive: true, mode: 0o700 })
const claudeCli = new ClaudeCli({
  bin: claudeBin,
  cwd: workDir,
  turnsDir,
  turnTimeoutMs: cfg.turnTimeoutMs,
  env: claudeEnv,
  keys,
  addDirs: agentDirs,
})
// Local models get the same Claude Code (tools, folder, approvals), pointed at LiteLLM's or Ollama's /v1/messages.
const localCli = new ClaudeCli({
  bin: claudeBin,
  cwd: workDir,
  turnsDir,
  turnTimeoutMs: cfg.turnTimeoutMs,
  env: { ...quiet, ...fleetEnv },
  keys,
  addDirs: agentDirs,
  endpoint: localEndpoint,
})

claudeCli.sweep()

// The same turns through ACP (the Claude ACP adapter driving the same Claude Code), when Settings says so.
// Off by default; the sessions are the same either way.
const acpOptions = {
  adapter: { bin: process.execPath, args: [adapterEntry()] },
  claudeBin,
  cwd: workDir,
  turnsDir,
  turnTimeoutMs: cfg.turnTimeoutMs,
  env: claudeAcpEnv,
  keys,
  addDirs: agentDirs,
}
const useAcp = () => settings.get().claudeAcp === 'on'
const claudeTurns = new ChosenEngine({ cli: claudeCli, acp: new ClaudeAcp(acpOptions), useAcp })
// Local models never get a saved Anthropic key: their own environment, not Claude's.
const localWithTools = new ChosenEngine({ cli: localCli, acp: new ClaudeAcp({ ...acpOptions, env: { ...quiet, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...fleetEnv }, endpoint: localEndpoint }), useAcp })

// Codex through its ACP adapter, the same way: on its own models (with its own sign-in) or a local model,
// which it reaches on the Ollama machine directly. Shows in the agent picker when the Codex CLI is installed.
const codexSetup = new AgentCli({ agent: 'codex', find: () => findAgentBin(codexBin, agentsPrefix), prefix: agentsPrefix, env: () => ({ ...process.env, ...codexEnv }) })
const claudeSetup = new AgentCli({ agent: 'claude', find: () => findAgentBin(claudeBin, agentsPrefix), prefix: agentsPrefix, env: () => ({ ...process.env, ...claudeEnv }) })
const agents = new Agents({
  setups: { claude: claudeSetup, codex: codexSetup },
  installer: new NpmInstall({ prefix: agentsPrefix }),
  signIn: new CliSignIn(),
  keys: process.platform === 'darwin' ? new Keychain() : new KeyFile(join(configDir, 'agent-keys.json')),
  keyEnv: { claude: [claudeEnv, claudeAcpEnv], codex: [codexEnv] },
  installed: (agent) => {
    if (agent === 'codex') quietCodex(cfg.codexHome ?? join(home, '.codex'))
    defaultAssistant()
  },
})
await agents.load()
const codexOptions = {
  adapter: { bin: process.execPath, args: [codexAdapterEntry()] },
  codexBin,
  env: codexEnv,
  cwd: workDir,
  turnsDir,
  turnTimeoutMs: cfg.turnTimeoutMs,
  keys,
  addDirs: agentDirs,
  // The Assistant on Codex: its persona, from Codex's agents (or Claude Code's until it's mirrored).
  persona: (id: string) => shared.instructions(id),
}
const codexTurns = new CodexAcp(codexOptions)
const codexLocal = new LocalTurns({
  withTools: new CodexAcp({ ...codexOptions, local: (name) => localModels.ollamaModel(name) }),
  chatOnly: localModels,
  usesTools: (m) => localModels.usesTools(m),
  gate: litellmGate,
})

// Skills, agents and MCP servers for both agents (the Skills, Agents and MCP pages).
const trash = new Bin(join(stateDir, 'bin'))
const shared = new SharedConfig({
  claude: new ClaudeShelf({ home, bin: acpOptions.claudeBin, trash }),
  codex: new CodexShelf({ home, ...(cfg.codexHome ? { codexHome: cfg.codexHome } : {}), bin: codexBin, trash }),
  keys: keyStore,
})

// A fresh install's Assistant (defaults/assistant.md), into every installed agent when none has one yet;
// an Assistant that's there is never replaced. Again after Settings › Agents installs an agent.
const defaultAssistantFile = new URL('../defaults/assistant.md', import.meta.url)
function defaultAssistant() {
  void shared.installDefault(ASSISTANT_ID, readFileSync(defaultAssistantFile, 'utf8'))
    .then((wrote) => wrote.length && console.log(`default Assistant added to ${wrote.join(' and ')}`))
    .catch((err) => console.error(`default Assistant: ${(err as Error).message}`))
}
defaultAssistant()

const conversations = new Conversations({
  store: new ChatFiles(join(stateDir, 'chats')),
  notices,
  engines: {
    claude: claudeTurns,
    local: new LocalTurns({ withTools: localWithTools, chatOnly: localModels, usesTools: (m) => localModels.usesTools(m), gate: litellmGate }),
    codex: codexTurns,
    codexLocal,
  },
  fleet,
  fleetMode,
  claudeVersions,
  defaultChatModel: cfg.defaultChatModel || DEFAULT_ASSISTANT_MODEL,
  inbox: new InboxFile(join(stateDir, 'inbox.json')),
  uploads: new UploadFiles(uploadsDir),
  folders: homeFolders,
  defaultFolder: workDir,
  titler: { claude: claudeCli, local: localModels },
  machineName: cfg.machineName,
  // How the Assistant reaches its workers, as it's told in its instructions.
  fleetNotes: fl.kind === 'builtin'
    ? { kind: 'builtin' }
    : { kind: 'scripts', fleet: displayFolder(home, join(fl.binDir, 'fleet')), fleetDir: displayFolder(home, fl.dir), handoff: fl.handoff && displayFolder(home, fl.handoff) },
})

const workers = fl.kind === 'scripts'
  ? new FleetWorkers({ claudeDir: fl.claudeDir, forgetBin: fl.forgetBin, machine: cfg.machineName })
  : new HubWorkers({
      conversations,
      records: fleet,
      machine: cfg.machineName,
      hasPersona: async (id, agent) => (agent === 'codex' ? (await shared.instructions(id)) !== null : shared.hasAgent(id, 'claude')),
    })

// Limeade (browser): Cloudflare Access sign-in when the server has it, else the browser on this computer; Web Push.
const access = cfg.access
  ? createAccessCheck({
      ...cfg.access,
      fetchCerts: async (url) => (await fetch(url, { signal: AbortSignal.timeout(8000) })).json() as Promise<{ keys?: any[] }>,
    })
  : null
const vapid = await vapidKeys(join(configDir, 'vapid.json'))
const subscribers = new SubscriberFile(join(stateDir, 'push-subscribers.json'))
const watchers = new ChatWatchers()
const pushOut = new PushOut(subscribers, webPushSender({ subject: cfg.pushSubject, keys: vapid }), console.log, (chatId) => watchers.anyWatching(chatId, Date.now()))
conversations.on('notice', (n) => void pushOut.notice(n))

createHub({
  access,
  devLogin: cfg.devLogin,
  trustedHosts: cfg.trustedHosts,
  machineName: cfg.machineName,
  ollama: lm.kind === 'ollama'
    ? {
        url: ollamaAt,
        setUrl: async (url) => {
          await settings.set('ollamaUrl', url)
          void machineModels.sync().catch(() => undefined)
        },
      }
    : null,
  webDir: cfg.webDir,
  push: { publicKey: vapid.publicKey, subscribers, out: pushOut, watchers },
  key,
  conversations,
  notices,
  fleetMode,
  localModels,
  machineModels,
  claudeVersions,
  codex: codexSetup,
  claude: claudeSetup,
  agents,
  settings,
  folders: homeFolders,
  files: homeFolders,
  defaultFolder: workDir,
  oneShot: { claude: claudeCli, local: localModels },
  workers,
  shared,
  toolbox: toolboxKey ? { url: cfg.toolboxUrl, key: toolboxKey } : null,
  version,
}).listen(port, '127.0.0.1', () => console.log(`Limeade on http://localhost:${port}`))

// Stopping (a deploy restarts the hub): Claude Code turns run on in their keepers and the next hub picks
// them up (the unit's KillMode=process leaves them alone); anything else saves what it had.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    console.log(`${sig}: handing running turns to the next hub`)
    void Promise.race([conversations.close(), new Promise((r) => setTimeout(r, 10_000))]).finally(() => process.exit(0))
  })
}

// The local-model list follows what the machines have (e.g. a model added or removed outside Limeade). With
// LiteLLM the server's unit turns this on (a dev copy must not restart the live LiteLLM by just starting);
// straight to Ollama there's nothing to restart, so it looks every minute.
const syncModels = () => void machineModels.sync().catch((err) => console.error(`local models sync failed: ${(err as Error).message}`))
if (lm.kind === 'litellm' ? lm.sync : true) syncModels()
if (lm.kind === 'ollama') setInterval(syncModels, 60_000)

// Fleet events: same 10 s rhythm as fleet-rewake; acts only while the fleet mode is "app". Built-in workers'
// reports become events here first.
let checking = false
setInterval(async () => {
  if (checking) return
  checking = true
  try {
    if (workers instanceof HubWorkers) await workers.watch()
    await conversations.checkFleet()
  } catch (err) {
    console.error(`fleet check failed: ${(err as Error).message}`)
  } finally {
    checking = false
  }
}, cfg.fleetPollMs)
