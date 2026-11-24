// Settings › Agents: which agents this box has (installed? which version? signed in?), installing a missing
// one, signing it in through its own CLI, or giving it an API key Limeade keeps. Already-installed agents
// are picked up as they are, with the sign-in they already have; Limeade never copies a sign-in.

import { EventEmitter } from 'node:events'
import { AGENT_PACKAGES, API_KEY_ENV, cleanCode, cleanKey, isOlder } from '../domain/agent-setup.ts'
import { AGENTS, agentLabel, isAgent, type Agent, type AgentStatus } from '../domain/models.ts'
import type { AgentInstaller, AgentSetup, AgentSignIn, InstallRun, SecretStore, SignInRun } from '../ports.ts'
import { HubError } from './conversations.ts'

export interface AgentView {
  agent: Agent
  name: string
  status: AgentStatus
  /** The version Limeade installs. */
  pinned: string
  /** A newer pinned version for an agent Limeade installed, or null. */
  update: string | null
  install: InstallRun | null
  signIn: SignInRun | null
  /** Limeade holds an API key for it. */
  keySaved: boolean
}

/** token: Claude's long-lived token for background runs (`claude setup-token`), next to its own sign-in. */
export type SignInHow = 'subscription' | 'console' | 'chatgpt' | 'token'

const HOWS: Record<Agent, readonly SignInHow[]> = { claude: ['subscription', 'console', 'token'], codex: ['chatgpt'] }

export function keyName(agent: Agent): string {
  return `${agent}-api-key`
}

/**
 * Emits 'agents' when something the page shows changed (an install or a sign-in ended, a key came or went),
 * and 'signed-in' { agent, how } when a sign-in finished well.
 */
export class Agents extends EventEmitter {
  private o: {
    setups: Record<Agent, AgentSetup>
    installer: AgentInstaller
    signIn: AgentSignIn
    keys: SecretStore
    /** The environment each agent's turns start with; a saved API key goes in here. */
    keyEnv: Record<Agent, Record<string, string | undefined>[]>
    /** After a finished install (Codex: its telemetry-off settings). */
    installed?: (agent: Agent) => void
  }
  constructor(o: Agents['o']) {
    super()
    this.o = o
  }

  /** At start: the API keys Limeade keeps go to their agents. */
  async load(): Promise<void> {
    for (const agent of AGENTS) {
      const key = await this.o.keys.get(keyName(agent)).catch(() => null)
      if (key) this.putKey(agent, key)
    }
  }

  async list(): Promise<AgentView[]> {
    return Promise.all(AGENTS.map((a) => this.view(a)))
  }

  get(agent: unknown): Promise<AgentView> {
    return this.view(this.agent(agent))
  }

  async view(agent: Agent): Promise<AgentView> {
    const status = await this.o.setups[agent].status()
    const pinned = AGENT_PACKAGES[agent].version
    return {
      agent,
      name: agentLabel(agent),
      status,
      pinned,
      update: status.installed && status.managed && status.version && isOlder(status.version, pinned) ? pinned : null,
      install: this.o.installer.run(agent),
      signIn: this.o.signIn.run(agent),
      keySaved: !!this.o.keyEnv[agent][0]?.[API_KEY_ENV[agent]],
    }
  }

  async install(agent: unknown): Promise<AgentView> {
    const a = this.agent(agent)
    const v = await this.view(a)
    if (v.status.installed && !v.update) throw new HubError(409, `${v.name} is already installed`)
    this.o.installer.start(a, () => {
      this.o.setups[a].forget?.()
      if (!this.o.installer.run(a)?.error) this.o.installed?.(a)
      this.emit('agents', { agent: a })
    })
    this.emit('agents', { agent: a })
    return this.view(a)
  }

  async startSignIn(agent: unknown, how: unknown): Promise<AgentView> {
    const a = this.agent(agent)
    if (typeof how !== 'string' || !HOWS[a].includes(how as SignInHow)) throw new HubError(400, `${agentLabel(a)} can't sign in that way`)
    const status = await this.o.setups[a].status()
    if (!status.installed || !status.path) throw new HubError(409, `Install ${agentLabel(a)} first`)
    await this.o.signIn.start(a, how as SignInHow, status.path, () => {
      this.o.setups[a].forget?.()
      this.emit('agents', { agent: a })
      if (this.o.signIn.run(a)?.state === 'done') this.emit('signed-in', { agent: a, how })
    })
    return this.view(a)
  }

  async sendCode(agent: unknown, code: unknown): Promise<AgentView> {
    const a = this.agent(agent)
    const c = cleanCode(code)
    if (!c) throw new HubError(400, 'Paste the code from the sign-in page')
    try {
      await this.o.signIn.sendCode(a, c)
    } catch (err) {
      throw new HubError(409, (err as Error).message)
    }
    return this.view(a)
  }

  async cancelSignIn(agent: unknown): Promise<AgentView> {
    const a = this.agent(agent)
    this.o.signIn.cancel(a)
    return this.view(a)
  }

  /** An API key for the agent, kept by Limeade and given to the agent as it starts. */
  async saveKey(agent: unknown, raw: unknown): Promise<AgentView> {
    const a = this.agent(agent)
    const key = cleanKey(raw)
    if (!key) throw new HubError(400, "That doesn't look like an API key")
    await this.o.keys.set(keyName(a), key)
    this.putKey(a, key)
    return this.after(a)
  }

  async removeKey(agent: unknown): Promise<AgentView> {
    const a = this.agent(agent)
    await this.o.keys.remove(keyName(a))
    this.putKey(a, null)
    return this.after(a)
  }

  private putKey(a: Agent, key: string | null): void {
    for (const env of this.o.keyEnv[a]) {
      if (key) env[API_KEY_ENV[a]] = key
      else delete env[API_KEY_ENV[a]]
    }
  }

  private after(a: Agent): Promise<AgentView> {
    this.o.setups[a].forget?.()
    this.emit('agents', { agent: a })
    return this.view(a)
  }

  private agent(v: unknown): Agent {
    if (!isAgent(v)) throw new HubError(404, 'No such agent')
    return v
  }
}
