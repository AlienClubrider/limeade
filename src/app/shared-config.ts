// Skills, agents and MCP servers once, for both Claude Code and Codex. The Skills, Agents and MCP pages
// show one list with who has each item; saving or deleting there changes both agents; mirroring copies
// what only one has to the other and asks which to keep where the two differ. Keys an MCP server needs
// go to the key store, and its configs only refer to them.

import {
  SIDES, codexCannot, maskLiterals, unmaskLiterals, describeMcp, frontmatter, keysUsed, liftKeys, pairUp, personaFromMarkdown, personaMarkdown, sameMcp, samePersona,
  sideName, stepFor, validId, whoHas, type Found, type Kind, type McpServer, type Pair, type Side, type Step,
} from '../domain/shared-config.ts'
import { KEPT_UP_TO_DATE, shouldWriteSkill } from '../domain/bundled-skills.ts'
import type { AgentShelf, FoundAgent, FoundSkill, KeyStore } from '../ports.ts'

export interface ListItem {
  id: string
  name: string
  description: string
  /** Who has it. */
  has: 'claude' | 'codex' | 'both'
  /** Both have it, and the two differ. */
  differs?: boolean
  /** From a Claude plugin: read-only, Claude only. */
  plugin?: string
  readOnly?: boolean
  /** Codex only has another app's markdown for it, which Codex doesn't load. */
  notLoaded?: string
}

export interface MirrorStep {
  kind: Kind
  id: string
  name: string
  has: ListItem['has']
  step: Step
  /** Keys that would move out of a config into the key store (names only). */
  keys?: string[]
}

/** Per item ("skill:foo"): which side to keep where they differ, or 'skip' to leave it alone. */
export type Choices = Record<string, Side | 'skip'>

const READ_ONLY = "This comes from a Claude plugin, so it can't be changed here"
const PLACEHOLDER = 'PASTE-HERE'

interface McpFound extends Found {
  server: McpServer
}

export class SharedConfig {
  private shelves: Record<Side, AgentShelf>
  private o: { claude: AgentShelf; codex: AgentShelf; keys: KeyStore }
  constructor(o: SharedConfig['o']) {
    this.o = o
    this.shelves = { claude: o.claude, codex: o.codex }
  }

  installed(): Record<Side, boolean> {
    return { claude: this.o.claude.installed(), codex: this.o.codex.installed() }
  }

  // ---------- reading ----------

  private async skillPairs(): Promise<Pair<FoundSkill>[]> {
    const [a, b] = await Promise.all([this.o.claude.skills(), this.o.codex.skills()])
    return pairUp(a, b)
  }

  private async agentPairs(): Promise<Pair<FoundAgent>[]> {
    const [a, b] = await Promise.all([this.o.claude.agents(), this.o.codex.agents()])
    return pairUp(a, b)
  }

  private async mcpPairs(): Promise<Pair<McpFound>[]> {
    const list = async (s: Side) => {
      if (!this.shelves[s].installed()) return []
      return Object.entries(await this.shelves[s].mcps()).map(([id, server]) => ({ id, name: id, description: describeMcp(server), server }))
    }
    const [a, b] = await Promise.all([list('claude'), list('codex')])
    return pairUp(a, b)
  }

  private sameSkill = (a: FoundSkill, b: FoundSkill) => a.realPath === b.realPath || a.hash === b.hash
  private sameAgent = (a: FoundAgent, b: FoundAgent) => samePersona(a.persona, b.persona)
  private sameServer = (a: McpFound, b: McpFound) => sameMcp(a.server, b.server, this.o.keys.values())

  async items(): Promise<Record<Kind, ListItem[]>> {
    const [skills, agents, mcps] = await Promise.all([this.skillPairs(), this.agentPairs(), this.mcpPairs()])
    const row = <T extends Found & { plugin?: string }>(p: Pair<T>, same: (a: T, b: T) => boolean): ListItem => {
      const it = (p.claude ?? p.codex)!
      const differs = !!(p.claude && p.codex && !p.codex.notLoaded && !same(p.claude, p.codex))
      const notLoaded = p.codex?.notLoaded
      return {
        id: p.id, name: it.name, description: it.description, has: whoHas(p),
        ...(differs ? { differs } : {}), ...(it.plugin ? { plugin: it.plugin, readOnly: true } : {}), ...(notLoaded ? { notLoaded } : {}),
      }
    }
    // Your own first, then plugin ones.
    const order = (l: ListItem[]) => [...l.filter((i) => !i.plugin), ...l.filter((i) => i.plugin)]
    return {
      skill: order(skills.map((p) => row(p, this.sameSkill))),
      agent: order(agents.map((p) => row(p, this.sameAgent))),
      mcp: mcps.map((p) => row(p, this.sameServer)),
    }
  }

  /** The item in the shared form (SKILL.md, a Claude agent file, MCP JSON), and an MCP server's keys. */
  async read(kind: Kind, id: string): Promise<{ content: string; keys?: { name: string; set: boolean }[]; inConfig?: string[]; codexCannot?: string | null }> {
    if (kind === 'skill') {
      const p = (await this.skillPairs()).find((x) => x.id === id)
      if (!p) throw new Error('No such skill')
      return { content: await (p.claude ? this.o.claude : this.o.codex).readSkill(id) }
    }
    if (kind === 'agent') {
      const p = (await this.agentPairs()).find((x) => x.id === id)
      if (!p) throw new Error('No such agent')
      return { content: p.claude?.markdown ?? personaMarkdown((p.claude ?? p.codex)!.persona) }
    }
    const p = (await this.mcpPairs()).find((x) => x.id === id)
    if (!p) throw new Error('No such server')
    const server = (p.claude ?? p.codex)!.server
    const have = this.o.keys.values()
    // Keys still written in a config stay on this computer: shown hidden, put back when saved.
    const masked = maskLiterals(server)
    return {
      content: JSON.stringify(masked.server, null, 2),
      keys: keysUsed(server).map((name) => ({ name, set: have[name] !== undefined })),
      inConfig: masked.hidden,
      codexCannot: codexCannot(server),
    }
  }

  // ---------- changing (both agents at once) ----------

  async save(kind: Kind, id: string, content: string, isNew = false): Promise<{ note?: string }> {
    if (id.includes(':')) throw new Error(READ_ONLY)
    if (!validId(id)) throw new Error('Name must be letters, numbers and dashes')
    if (kind === 'mcp') return this.saveMcp(id, content, isNew)
    const fm = frontmatter(content)
    if (!fm.name || !fm.description) throw new Error('It needs a name and description at the top')
    if (kind === 'skill') {
      const p = (await this.skillPairs()).find((x) => x.id === id)
      if (isNew && p) throw new Error(`There is already a skill called ${id}`)
      if (!p) {
        // A new skill lives in the shared folder; Claude gets a link to it.
        await this.o.codex.writeSkill(id, content)
        const made = (await this.o.codex.skills()).find((s) => s.id === id)!
        await this.o.claude.linkSkill(id, made.realPath)
        return {}
      }
      // One folder: one write. Two copies: both.
      await (p.claude ? this.o.claude : this.o.codex).writeSkill(id, content)
      if (p.claude && p.codex && p.claude.realPath !== p.codex.realPath) await this.o.codex.writeSkill(id, content)
      if (!p.claude || !p.codex) await this.mirrorOne('skill', id, p.claude ? 'claude' : 'codex')
      return {}
    }
    const exists = (await this.agentPairs()).find((x) => x.id === id)
    if (isNew && exists) throw new Error(`There is already an agent called ${id}`)
    const persona = personaFromMarkdown(id, content)
    await this.o.claude.writeAgent(id, persona, content)
    await this.o.codex.writeAgent(id, persona)
    return {}
  }

  private async saveMcp(id: string, content: string, isNew: boolean): Promise<{ note?: string }> {
    let server: McpServer
    try {
      server = JSON.parse(content)
    } catch {
      throw new Error('That is not valid JSON')
    }
    if (!server || typeof server !== 'object' || Array.isArray(server) || (typeof server.command !== 'string' && typeof server.url !== 'string')) {
      throw new Error('A server needs a "command" (and "args") or a "url"')
    }
    if (JSON.stringify(server).includes(PLACEHOLDER)) throw new Error(`Replace ${PLACEHOLDER} with the real value first (it goes to the key store, not the config)`)
    const exists = (await this.mcpPairs()).find((x) => x.id === id)
    if (isNew && exists) throw new Error(`There is already a server called ${id}`)
    server = unmaskLiterals(server, isNew ? undefined : (exists?.claude ?? exists?.codex)?.server)
    const { server: clean, keys } = liftKeys(id, server, this.o.keys.values())
    for (const [name, value] of Object.entries(keys)) await this.o.keys.set(name, value)
    const notes: string[] = []
    let wrote = 0
    for (const side of SIDES) {
      if (!this.shelves[side].installed()) continue
      const why = side === 'codex' ? codexCannot(clean) : null
      if (why) {
        notes.push(`Saved for Claude Code only: ${why}`)
        continue
      }
      await this.shelves[side].writeMcp(id, clean)
      wrote++
    }
    if (!wrote) throw new Error('Neither Claude Code nor Codex is installed here')
    return notes.length ? { note: notes.join('. ') } : {}
  }

  async remove(kind: Kind, id: string): Promise<void> {
    if (id.includes(':')) throw new Error(READ_ONLY)
    if (!validId(id)) throw new Error('Bad name')
    for (const side of SIDES) {
      const s = this.shelves[side]
      if (kind === 'skill') await s.removeSkill(id)
      else if (kind === 'agent') await s.removeAgent(id)
      else if (s.installed()) await s.removeMcp(id)
    }
  }

  async setKey(name: string, value: string): Promise<void> {
    if (value) await this.o.keys.set(name, value)
    else await this.o.keys.remove(name)
  }

  // ---------- the Assistant ----------

  /** Whether an agent (persona) by this id is there for one side to run as. */
  async hasAgent(id: string, side: Side): Promise<boolean> {
    return (await this.shelves[side].agents()).some((a) => a.id === id)
  }

  /**
   * A persona's instructions for a Codex turn that runs as it: Codex's own copy, else Claude Code's (not
   * mirrored yet), so the Assistant is the same on both. Null when neither agent has it.
   */
  async instructions(id: string): Promise<string | null> {
    for (const side of ['codex', 'claude'] as const) {
      const it = (await this.shelves[side].agents()).find((a) => a.id === id && !a.plugin)
      if (it?.persona.instructions.trim()) return it.persona.instructions
    }
    return null
  }

  /**
   * A fresh install's agent (the default Assistant): written into every installed agent, only when no
   * agent has one by that id yet. One that's there is never replaced, and an agent that has none while
   * the other has one is left to mirroring. Returns where it was written.
   */
  async installDefault(id: string, markdown: string): Promise<Side[]> {
    const found = await Promise.all(SIDES.map((s) => this.shelves[s].agents()))
    if (found.flat().some((a) => a.id === id)) return []
    const persona = personaFromMarkdown(id, markdown)
    const wrote: Side[] = []
    for (const side of SIDES) {
      if (!this.shelves[side].installed()) continue
      await this.shelves[side].writeAgent(id, persona, side === 'claude' ? markdown : undefined)
      wrote.push(side)
    }
    return wrote
  }

  /**
   * A skill that ships with Limeade, for both agents: added when neither has it, and brought up to date
   * while it's still Limeade's own copy (see shouldWriteSkill). Returns whether it was written.
   */
  async installSkill(id: string, markdown: string): Promise<boolean> {
    if (!SIDES.some((s) => this.shelves[s].installed())) return false
    const p = (await this.skillPairs()).find((x) => x.id === id)
    const copies = p ? await Promise.all(SIDES.filter((s) => p[s]).map((s) => this.shelves[s].readSkill(id))) : []
    // A copy that's Limeade's own and out of date, or Limeade's own copy that only one agent has yet.
    const write = !p || copies.some((c) => shouldWriteSkill(c, markdown)) || (copies.length === 1 && copies[0]!.includes(KEPT_UP_TO_DATE))
    if (!write) return false
    await this.save('skill', id, markdown, false)
    return true
  }

  // ---------- mirroring ----------

  /** What mirroring would do, item by item. Empty unless both agents are installed. */
  async plan(): Promise<MirrorStep[]> {
    const inst = this.installed()
    if (!inst.claude || !inst.codex) return []
    const [skills, agents, mcps] = await Promise.all([this.skillPairs(), this.agentPairs(), this.mcpPairs()])
    const out: MirrorStep[] = []
    // Plugin items belong to their plugin: not copied, not listed here.
    const own = <T extends { plugin?: string }>(p: Pair<T & Found>) => !(p.claude?.plugin ?? p.codex?.plugin)
    for (const p of skills.filter(own)) out.push({ kind: 'skill', id: p.id, name: (p.claude ?? p.codex)!.name, has: whoHas(p), step: stepFor(p, this.sameSkill) })
    for (const p of agents.filter(own)) out.push({ kind: 'agent', id: p.id, name: (p.claude ?? p.codex)!.name, has: whoHas(p), step: stepFor(p, this.sameAgent) })
    const have = this.o.keys.values()
    for (const p of mcps) {
      const step = stepFor(p, this.sameServer, (from, it) => (from === 'claude' ? codexCannot(it.server) : null))
      const keys = new Set<string>()
      for (const it of [p.claude, p.codex]) {
        if (!it || step.action === 'same') continue
        try {
          for (const k of Object.keys(liftKeys(p.id, it.server, have).keys)) keys.add(k)
        } catch {}
      }
      out.push({ kind: 'mcp', id: p.id, name: p.id, has: whoHas(p), step, ...(keys.size ? { keys: [...keys].sort() } : {}) })
    }
    return out
  }

  /**
   * Copies everything one agent has and the other hasn't, and for items that differ, the side chosen
   * (`choices["skill:foo"] = 'claude'`); differing items without a choice, and items marked 'skip', are left alone.
   */
  async mirror(choices: Choices = {}): Promise<{ done: string[]; failed: { item: string; error: string }[] }> {
    const done: string[] = []
    const failed: { item: string; error: string }[] = []
    for (const s of await this.plan()) {
      const key = `${s.kind}:${s.id}`
      if (choices[key] === 'skip') continue
      const from = s.step.action === 'copy' ? s.step.from : s.step.action === 'choose' ? (choices[key] as Side | undefined) : undefined
      if (!from) continue
      try {
        await this.mirrorOne(s.kind, s.id, from)
        done.push(key)
      } catch (err) {
        failed.push({ item: key, error: (err as Error).message })
      }
    }
    return { done, failed }
  }

  /** `from`'s version of one item becomes both agents' (what the other had goes to the bin). */
  private async mirrorOne(kind: Kind, id: string, from: Side): Promise<void> {
    const to = from === 'claude' ? this.o.codex : this.o.claude
    if (kind === 'skill') {
      const it = (await this.shelves[from].skills()).find((s) => s.id === id)
      if (!it || it.plugin) throw new Error(`${sideName(from)} has no skill ${id} to copy`)
      // A link, not a copy: one folder, so a change shows in both.
      return to.linkSkill(id, it.realPath)
    }
    if (kind === 'agent') {
      const it = (await this.shelves[from].agents()).find((a) => a.id === id)
      if (!it || it.plugin) throw new Error(`${sideName(from)} has no agent ${id} to copy`)
      await to.writeAgent(id, it.persona)
      // Codex's own copy, when what it had was another app's markdown it doesn't load.
      if (from === 'codex' && it.notLoaded) await this.o.codex.writeAgent(id, it.persona)
      return
    }
    const server = (await this.shelves[from].mcps())[id]
    if (!server) throw new Error(`${sideName(from)} has no server ${id} to copy`)
    const { server: clean, keys } = liftKeys(id, server, this.o.keys.values())
    for (const [name, value] of Object.entries(keys)) await this.o.keys.set(name, value)
    // The config it came from stays exactly as it is, so the agent still works when started outside
    // Limeade; only the copy refers to the key store.
    await to.writeMcp(id, clean)
  }
}
