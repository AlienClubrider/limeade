// What the core needs from the outside world. Adapters in src/adapters implement these.

import type { Attachment, StoredAttachment } from './domain/attachments.ts'
import type { Chat, Effort, Message, Mode, Step } from './domain/chat.ts'
import type { FleetMode } from './domain/fleet.ts'
import type { ModelGroup } from './domain/models.ts'
import type { Found, McpServer, Persona, Side } from './domain/shared-config.ts'

/** A tool call waiting for the user (Claude Code's permission prompt). */
export interface ApprovalRequest {
  tool: string
  /** One plain line: the command, file or URL. */
  text: string
  /** Claude Code's own wording, e.g. "Run the matching tests". */
  description: string
  /** What "Yes, and don't ask again" would allow, e.g. "npm run test:*". Empty when it can't be remembered. */
  alwaysLabel: string
}

export type ApprovalDecision = 'yes' | 'always' | 'no'

export type EngineEvent =
  | { type: 'text'; text: string }
  | { type: 'step'; step: Step }
  | { type: 'model'; alias: string; modelId: string }
  | { type: 'approval'; request: ApprovalRequest; answer: (decision: ApprovalDecision, message?: string) => void }
  /** A turn picked up after a hub restart: everything it had said and done so far. */
  | { type: 'resumed'; text: string; steps: Step[] }

export interface TurnRequest {
  prompt: string
  /** Files sent with this message (Claude only). */
  attachments?: readonly StoredAttachment[]
  /** Earlier messages, for engines that don't keep their own history. */
  history: readonly Message[]
  /** Model name inside the engine ("opus", "llama3.1-8b"). */
  model: string
  effort: Effort
  mode: Mode
  sessionId: string | null
  /** Working folder for Claude Code (plain chats); the engine's default when absent. */
  cwd?: string
  /** Claude Code agent to run as (the Assistant). */
  agent?: string
  appendSystemPrompt?: string
  /** No subagents of the agent's own (the Assistant: everything it hands off goes to a worker the user can see). */
  noSubagents?: boolean
  /** Extra environment for this turn's agent (a worker's FLEET_SLUG). */
  env?: Record<string, string>
  signal: AbortSignal
  onEvent: (e: EngineEvent) => void
  /** The turn is running somewhere that outlives the hub; `handle` picks it up again (reattach). */
  onStart?: (handle: string) => void
  /**
   * The running turn takes messages from him now (steering): `steer` hands one in. Its promise says
   * whether the agent took it in (true) or the turn ended without it (false, so the hub runs it as a
   * turn of its own). Engines that can't steer never call this.
   */
  onSteerable?: (steer: Steer) => void
}

/** A message from him for the turn that's running, with any files sent with it. */
export interface SteerMessage {
  id: string
  prompt: string
  attachments?: readonly StoredAttachment[]
}

/** Hands a message to the running turn; false when it can't (the turn is ending). */
export type Steer = (m: SteerMessage) => Promise<boolean>

export interface TurnResult {
  text: string
  /** The Claude Code session the turn ran in (new or resumed). */
  sessionId: string | null
  /** Set when the turn failed; `text` may still hold partial output. */
  error?: string
  /** True when the session to resume no longer exists. */
  sessionLost?: boolean
}

export interface TurnEngine {
  run(req: TurnRequest): Promise<TurnResult>
  /**
   * Picks up a turn an earlier hub started (the handle from onStart) and finishes it like run(). Null when
   * there's nothing to pick up. Engines whose turns die with the hub leave this out.
   */
  reattach?(handle: string, req: TurnRequest): Promise<TurnResult | null>
}

export interface ChatStore {
  list(): Chat[]
  get(id: string): Chat | null
  save(chat: Chat): Promise<void>
  remove(id: string): Promise<void>
}

export interface FleetLog {
  lines(): Promise<string[]>
  /** The assistant's ack cursor (~/bin/fleet ack). */
  cursor(): Promise<number>
  /** The last event seq that already woke an assistant (shared with fleet-rewake). */
  lastWake(): Promise<number>
  setLastWake(seq: number): Promise<void>
}

export interface FleetModeStore {
  get(): Promise<FleetMode>
  set(mode: FleetMode): Promise<void>
  /** True when there's no choice to make (built-in workers). */
  readonly fixed?: boolean
}

/** Built-in workers' records: what each reported (fleet status), the job list, and the events the hub writes. */
export interface FleetRecords {
  statusLines(slug: string): Promise<import('./domain/workers.ts').StatusLine[]>
  backlog(): Promise<string>
  addEvent(slug: string, kind: string, text: string): Promise<void>
  /** How many of a worker's status lines have been looked at (survives restarts). */
  seen(slug: string): Promise<number>
  setSeen(slug: string, lines: number): Promise<void>
}

export interface LocalModels {
  groups(): Promise<ModelGroup[]>
}

/** Small key-value state the hub keeps between restarts (e.g. which Claude version each alias is). */
export interface KeyValue {
  get(): Record<string, string>
  set(key: string, value: string): Promise<void>
}

/** Things the phone should buzz for, kept so a reconnecting phone can catch up. */
export interface Notice {
  seq: number
  at: string
  kind: 'done' | 'needs' | 'approval' | 'reply'
  title: string
  body: string
  chatId: string
  approvalId?: string
  /** The bell item this notice is about; tapping the notification opens it. */
  inboxId?: string
  /** Settings' "Send a test": shown even while its chat is on screen, so it really tests delivery. */
  test?: boolean
}

export interface NoticeLog {
  since(seq: number): Notice[]
  append(n: Omit<Notice, 'seq' | 'at'>): Promise<Notice>
}

/** The assistant's workers (agent sessions) and a way to stop one. */
export interface WorkerSource {
  list(): Promise<import('./domain/workers.ts').WorkerSummary[]>
  get(id: string): Promise<import('./domain/workers.ts').WorkerDetail | null>
  stop(id: string): Promise<void>
  /** Built-in workers: the Assistant starts one (persona, title, folder, brief; agent and model optional)… */
  start?(o: { persona: string; title: string; folder: string; brief: string; agent?: unknown; model?: unknown }): Promise<import('./domain/workers.ts').WorkerDetail>
  /** …and answers or steers it. */
  send?(id: string, text: unknown): Promise<void>
}

/** One-shot text from a model, no tools (Toolbox drafts). model is the engine's own name ("opus", "qwen2.5-7b"). */
export interface OneShot {
  complete(req: { model: string; effort: import('./domain/chat.ts').Effort; system: string; prompt: string; json?: boolean }): Promise<string>
}

/** The bell's items, kept so a restart doesn't lose open questions. */
export interface InboxStore {
  all(): import('./domain/inbox.ts').InboxItem[]
  put(item: import('./domain/inbox.ts').InboxItem): Promise<void>
  remove(id: string): Promise<void>
}

/** Files the user uploads, kept on the box per chat so the Assistant can use them later. */
export interface AttachmentStore {
  /** Saves one upload; 'too-big' (and nothing kept) when it passes maxBytes. */
  save(chatId: string, name: string, body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Attachment | 'too-big'>
  get(chatId: string, id: string): Promise<StoredAttachment | null>
}

/** Folders under the home folder of this box, for a chat's working folder. Never anything outside it. */
export interface HomeFolders {
  readonly home: string
  /** The real path of an existing folder inside home (symlinks followed), or null. */
  resolve(path: string): Promise<string | null>
  /** The folders directly inside one (absolute paths, sorted), skipping hidden and clutter unless asked. */
  list(path: string, opts?: { hidden?: boolean }): Promise<string[]>
  /** Folders below home whose path matches the words, shallow ones first. */
  search(query: string, limit?: number): Promise<string[]>
}

/** Files inside home, for opening what an agent made (a diagram, a page) from a link in its reply. */
export interface HomeFiles {
  /** The real path of an existing file inside home (symlinks followed), or null. */
  resolveFile(path: string): Promise<string | null>
}

/** Ollama on one of the user's machines. */
export interface OllamaApi {
  /** Installed models, or null when the machine doesn't answer. */
  installed(m: import('./domain/local-models.ts').OllamaMachine): Promise<import('./domain/local-models.ts').InstalledModel[] | null>
  /** Pulls a model; each progress line goes to onLine. Throws on Ollama's error or when aborted. */
  pull(m: import('./domain/local-models.ts').OllamaMachine, tag: string, signal: AbortSignal, onLine: (line: Record<string, unknown>) => void): Promise<void>
  remove(m: import('./domain/local-models.ts').OllamaMachine, tag: string): Promise<void>
}

/** A model in the Ollama library. `sizes` are its size tags ("8b"). */
export interface LibraryModel {
  name: string
  description: string
  /** "tools", "vision", "thinking"… */
  capabilities: string[]
  sizes: string[]
  pulls: string
}

/** One pullable tag ("qwen3:8b") with its download size when known. */
export interface LibraryTag {
  tag: string
  bytes: number | null
  context: string
}

export interface LibrarySource {
  models(): Promise<{ models: LibraryModel[]; fetchedAt: number | null; fallback: boolean }>
  tags(name: string): Promise<LibraryTag[]>
}

/** The generated local-model part of LiteLLM's config, and a way to make LiteLLM load it. */
export interface LiteLlmModelsFile {
  /** What's there now (empty when nothing has been generated yet). */
  read(): Promise<import('./domain/local-models.ts').LiteLlmEntry[] | null>
  write(entries: readonly import('./domain/local-models.ts').LiteLlmEntry[]): Promise<void>
  /** Restarts LiteLLM and waits until it answers again. */
  restart(): Promise<void>
}

/** Whether an agent is installed on this box and signed in; asked often, so cheap. */
export interface AgentSetup {
  status(): Promise<import('./domain/models.ts').AgentStatus>
  /** Ask the CLI again next time (after an install or a sign-in). */
  forget?(): void
}

/** Installing an agent's pinned package into the user's own folder, one run per agent at a time. */
export interface AgentInstaller {
  /** Starts (or returns the running) install; `done` runs when it ends either way. */
  start(agent: import('./domain/models.ts').Agent, done: () => void): InstallRun
  run(agent: import('./domain/models.ts').Agent): InstallRun | null
}

export interface InstallRun {
  version: string
  running: boolean
  error: string | null
  /** The end of the installer's output, for when it fails. */
  log: string
}

/** The agent's own sign-in, run through its CLI: a link to open, maybe a code to paste back. */
export interface AgentSignIn {
  start(agent: import('./domain/models.ts').Agent, how: 'subscription' | 'console' | 'chatgpt' | 'token', bin: string, done: () => void): Promise<SignInRun>
  sendCode(agent: import('./domain/models.ts').Agent, code: string): Promise<SignInRun>
  run(agent: import('./domain/models.ts').Agent): SignInRun | null
  cancel(agent: import('./domain/models.ts').Agent): void
}

export interface SignInRun {
  state: 'starting' | 'waiting' | 'checking' | 'done' | 'failed'
  link: import('./domain/agent-setup.ts').SignInLink | null
  error: string | null
  /** Which sign-in: Claude's long-lived token ('token') or the agent's own. */
  how?: 'subscription' | 'console' | 'chatgpt' | 'token'
}

/** Secrets Limeade keeps itself (an agent's API key): the macOS Keychain, or a 0600 file elsewhere. */
export interface SecretStore {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  remove(name: string): Promise<void>
}

/** Keys MCP servers need, kept outside every config file (macOS Keychain, or a private file). */
export interface KeyStore {
  /** Every key by name (loaded at start, so cheap). */
  values(): Record<string, string>
  set(name: string, value: string): Promise<void>
  remove(name: string): Promise<void>
}

/** A skill as one agent has it: `realPath` is the folder it really lives in, `hash` its contents. */
export interface FoundSkill extends Found {
  realPath: string
  hash: string
  /** From a Claude plugin: shown, never changed or copied. */
  plugin?: string
}

export interface FoundAgent extends Found {
  persona: Persona
  /** Claude: the agent file as it is (its own settings, e.g. tools and model, ride along). */
  markdown?: string
  plugin?: string
}

/**
 * One agent's own config on this computer (Claude Code: ~/.claude and ~/.claude.json; Codex: ~/.codex and
 * the shared ~/.agents/skills). Removing puts things in Limeade's bin, never deletes.
 */
export interface AgentShelf {
  readonly side: Side
  /** Whether the agent is installed here (nothing is read or written for one that isn't). */
  installed(): boolean
  skills(): Promise<FoundSkill[]>
  readSkill(id: string): Promise<string>
  /** Writes SKILL.md (through a link, into the shared folder). A new one goes in a new folder. */
  writeSkill(id: string, content: string): Promise<void>
  /** Points this agent's skill at a folder that lives elsewhere; what was there goes to the bin. */
  linkSkill(id: string, realPath: string): Promise<void>
  removeSkill(id: string): Promise<void>
  agents(): Promise<FoundAgent[]>
  writeAgent(id: string, persona: Persona, markdown?: string): Promise<void>
  removeAgent(id: string): Promise<void>
  mcps(): Promise<Record<string, McpServer>>
  writeMcp(id: string, server: McpServer): Promise<void>
  removeMcp(id: string): Promise<void>
}

/** Monitors and their run logs, kept between restarts. */
export interface MonitorStore {
  list(): Promise<import('./domain/monitors.ts').Monitor[]>
  save(m: import('./domain/monitors.ts').Monitor): Promise<void>
  remove(id: string): Promise<void>
  writeLog(id: string, runId: string, text: string): Promise<void>
  readLog(id: string, runId: string): Promise<string | null>
  removeLog(id: string, runId: string): Promise<void>
}

/** Runs a monitor's check: a shell command in its folder, with a time limit. */
export interface CheckRunner {
  run(command: string, cwd: string): Promise<{ output: string; code: number | null; error?: string }>
}

/** One unattended agent turn for a monitor run: no chat, nobody to approve anything. */
export interface MonitorTurn {
  prompt: string
  cwd: string
  /** The agent to run as ("apologist"), or null for none. */
  agent: string | null
  /** Told on top of the agent's own instructions (how to end the run). */
  note: string
  signal: AbortSignal
  onEvent: (e: EngineEvent) => void
  /** The turn runs in a process that outlives the hub; `handle` picks it up again. */
  onStart?: (handle: string) => void
}

export interface MonitorTurns {
  run(t: MonitorTurn): Promise<TurnResult>
  /** Follows a turn an earlier hub started to its end; null when there's nothing to pick up. */
  reattach(handle: string, t: MonitorTurn): Promise<TurnResult | null>
}
